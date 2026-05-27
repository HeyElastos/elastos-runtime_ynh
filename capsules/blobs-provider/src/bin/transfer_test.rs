//! Standalone end-to-end test for iroh-blobs direct transfer.
//!
//! Run two instances on the same machine (or two machines) to prove the
//! unlimited-bounded-by-disk file transfer path works without any daemon
//! mediation, HTTP body limits, or base64 staging.
//!
//!   # terminal A — send a large file
//!   cargo run --bin blobs-transfer-test -- send ./my-large-file.mkv
//!   # → prints a ticket; copy it.
//!
//!   # terminal B — receive
//!   cargo run --bin blobs-transfer-test -- receive <TICKET> ./out.mkv
//!
//! The sending process must stay running until the receiver finishes
//! (or until another peer has pulled the blob and can re-serve it).

use anyhow::Result;
use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{store::mem::MemStore, ticket::BlobTicket, BlobsProtocol};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let endpoint = Endpoint::bind(presets::N0).await?;
    let store = MemStore::new();
    let blobs = BlobsProtocol::new(&store, None);

    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    match arg_refs.as_slice() {
        ["send", filename] => {
            let abs = std::path::absolute(PathBuf::from(filename))?;
            eprintln!("hashing {}…", abs.display());
            let tag = store.blobs().add_path(abs).await?;
            let ticket = BlobTicket::new(endpoint.id().into(), tag.hash, tag.format);

            println!("{ticket}");
            eprintln!(
                "fetch with: cargo run --bin blobs-transfer-test -- receive {ticket} <DEST>"
            );

            let router = Router::builder(endpoint)
                .accept(iroh_blobs::ALPN, blobs)
                .spawn();
            eprintln!("serving — Ctrl-C to stop");
            tokio::signal::ctrl_c().await?;
            router.shutdown().await?;
        }
        ["receive", ticket, dest] => {
            let ticket: BlobTicket = ticket.parse()?;
            let dest_abs = std::path::absolute(PathBuf::from(dest))?;
            let downloader = store.downloader(&endpoint);
            eprintln!("downloading {}…", ticket.hash());
            downloader
                .download(ticket.hash(), Some(ticket.addr().id))
                .await?;
            store.blobs().export(ticket.hash(), &dest_abs).await?;
            eprintln!("wrote {}", dest_abs.display());
            endpoint.close().await;
        }
        _ => {
            eprintln!("usage:");
            eprintln!("  blobs-transfer-test send <FILE>");
            eprintln!("  blobs-transfer-test receive <TICKET> <DEST>");
            std::process::exit(2);
        }
    }
    Ok(())
}
