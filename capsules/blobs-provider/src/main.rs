//! blobs-provider — iroh-blobs direct peer-to-peer file transfer.
//!
//! Wire protocol mirrors `ipfs-provider`: line-delimited JSON requests on
//! stdin, line-delimited JSON responses on stdout. Persistent FsStore under
//! $XDG_DATA_HOME/elastos/blobs-provider so blobs survive restarts.
//!
//! Operations:
//!   init                                   start endpoint + store + router
//!   add_path  { path }                     -> { hash, ticket }
//!   add_bytes { data_base64 }              -> { hash, ticket }    (small files only)
//!   fetch     { ticket, dest }             -> { hash, bytes }
//!   share     { hash }                     -> { ticket }
//!   list                                   -> { blobs: [{ hash }] }
//!   drop      { hash }                     -> { ok }
//!
//! Phase 1: scaffold of the real iroh-blobs API. Some operations are stubbed
//! pending verification against a running node — the goal of this phase is
//! the end-to-end send/recv test in `src/bin/transfer_test.rs`.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{store::fs::FsStore, ticket::BlobTicket, BlobsProtocol};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
#[allow(dead_code)]
enum Request {
    Init {},
    AddPath { path: String },
    AddBytes { data_base64: String },
    Fetch { ticket: String, dest: String },
    Share { hash: String },
    List {},
    Drop { hash: String },
}

// Wire protocol matches elastos-runtime's ProviderResponse (bridge.rs):
//   { "status": "ok",    "data": <value> }
//   { "status": "error", "code": "<short>", "message": "<long>" }
// Anything else and the Init handshake fails with BridgeError::InitFailed,
// which the runtime logs at debug! and the provider never registers.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Response {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
    Error {
        code: String,
        message: String,
    },
}

impl Response {
    fn ok(data: serde_json::Value) -> Self {
        Self::Ok { data: Some(data) }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self::Error { code: "blobs_provider".into(), message: msg.into() }
    }
}

struct Node {
    endpoint: Endpoint,
    store: FsStore,
    _router: Router,
}

impl Node {
    async fn spawn(data_dir: PathBuf) -> Result<Self> {
        tokio::fs::create_dir_all(&data_dir).await.ok();
        let endpoint = Endpoint::bind(presets::N0).await?;
        let store = FsStore::load(&data_dir).await?;
        let blobs = BlobsProtocol::new(&store, None);
        let router = Router::builder(endpoint.clone())
            .accept(iroh_blobs::ALPN, blobs)
            .spawn();
        Ok(Self { endpoint, store, _router: router })
    }

    async fn add_path(&self, path: PathBuf) -> Result<(String, String)> {
        let abs = std::path::absolute(&path).context("absolute path")?;
        let tag = self.store.blobs().add_path(abs).await?;
        let ticket = BlobTicket::new(self.endpoint.id().into(), tag.hash, tag.format);
        Ok((tag.hash.to_string(), ticket.to_string()))
    }

    async fn fetch(&self, ticket_str: &str, dest: PathBuf) -> Result<String> {
        let ticket: BlobTicket = ticket_str.parse()?;
        let downloader = self.store.downloader(&self.endpoint);
        downloader.download(ticket.hash(), Some(ticket.addr().id)).await?;
        let abs = std::path::absolute(&dest).context("absolute dest")?;
        self.store.blobs().export(ticket.hash(), abs).await?;
        Ok(ticket.hash().to_string())
    }
}

fn data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".local/share")
        });
    base.join("elastos/blobs-provider")
}

async fn handle(node: &Mutex<Option<Node>>, req: Request) -> Response {
    match req {
        Request::Init {} => {
            let mut guard = node.lock().await;
            if guard.is_some() {
                return Response::ok(serde_json::json!({ "already_initialized": true }));
            }
            match Node::spawn(data_dir()).await {
                Ok(n) => {
                    let node_id = n.endpoint.id().to_string();
                    *guard = Some(n);
                    Response::ok(serde_json::json!({ "node_id": node_id }))
                }
                Err(e) => Response::err(format!("init failed: {e:#}")),
            }
        }
        Request::AddPath { path } => {
            let guard = node.lock().await;
            let Some(n) = guard.as_ref() else {
                return Response::err("not initialized — send `init` first");
            };
            match n.add_path(PathBuf::from(path)).await {
                Ok((hash, ticket)) => Response::ok(serde_json::json!({ "hash": hash, "ticket": ticket })),
                Err(e) => Response::err(format!("add_path failed: {e:#}")),
            }
        }
        Request::AddBytes { data_base64 } => {
            let guard = node.lock().await;
            let Some(n) = guard.as_ref() else {
                return Response::err("not initialized");
            };
            let bytes = match BASE64.decode(&data_base64) {
                Ok(b) => b,
                Err(e) => return Response::err(format!("invalid base64: {e}")),
            };
            let tmp = match tempfile_path() {
                Ok(p) => p,
                Err(e) => return Response::err(format!("tempfile: {e:#}")),
            };
            if let Err(e) = tokio::fs::write(&tmp, &bytes).await {
                return Response::err(format!("write tmp: {e:#}"));
            }
            let result = n.add_path(tmp.clone()).await;
            let _ = tokio::fs::remove_file(&tmp).await;
            match result {
                Ok((hash, ticket)) => Response::ok(serde_json::json!({ "hash": hash, "ticket": ticket })),
                Err(e) => Response::err(format!("add_bytes failed: {e:#}")),
            }
        }
        Request::Fetch { ticket, dest } => {
            let guard = node.lock().await;
            let Some(n) = guard.as_ref() else {
                return Response::err("not initialized");
            };
            match n.fetch(&ticket, PathBuf::from(dest)).await {
                Ok(hash) => Response::ok(serde_json::json!({ "hash": hash })),
                Err(e) => Response::err(format!("fetch failed: {e:#}")),
            }
        }
        Request::Share { hash } => {
            // For now, callers should retain the ticket from add_path. Re-minting a
            // ticket from a bare hash requires the BlobFormat, which we don't currently
            // persist alongside the hash. Phase 1 follow-up: keep a tag table.
            Response::err(format!(
                "share-by-hash not yet implemented (hash={hash}) — retain ticket from add_path"
            ))
        }
        Request::List {} => {
            // Phase 1 follow-up: iterate store.blobs() once method shape is verified.
            Response::err("list not yet implemented")
        }
        Request::Drop { hash: _ } => {
            // Phase 1 follow-up: tag drop + GC.
            Response::err("drop not yet implemented")
        }
    }
}

fn tempfile_path() -> Result<PathBuf> {
    let dir = std::env::temp_dir();
    let n: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos() as u64;
    Ok(dir.join(format!("blobs-provider-{n}.bin")))
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let node: Mutex<Option<Node>> = Mutex::new(None);
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => handle(&node, req).await,
            Err(e) => Response::err(format!("invalid request: {e}")),
        };
        let mut out = serde_json::to_vec(&resp)?;
        out.push(b'\n');
        stdout.write_all(&out).await?;
        stdout.flush().await?;
    }
    Ok(())
}
