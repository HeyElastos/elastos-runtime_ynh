# hey-home

A Hey-themed fork of the upstream `home` shell capsule for Elastos.

Same window-manager, launcher, taskbar, and capability-token wiring as
the stock `home` capsule — re-skinned to match the Hey design language:

- Radial-blue wallpaper (`#162747 → #091427 → #020916`) with golden,
  indigo, and pink glows
- Frosted-glass cards, gold accent (`#d4b84b`), Dancing Script wordmarks
- A welcome / lock screen rendered before the desktop, showing the
  active user (e.g. `@EverlastingOS`), their `did:key`, mesh status,
  and an Unlock / Use-passkey action
- A `Carrier · N peers` pill in the toolbar and a federation status
  footer over the desktop

## Files

| File | Purpose |
| --- | --- |
| `browser/hey-theme.css` | Theme override layer — re-tints the upstream shell |
| `browser/hey-welcome.css` | Welcome screen styles |
| `browser/hey-welcome.js` | Welcome screen build + clock + unlock animation |
| `browser/hey-logo.svg` | Gold "H" tile that replaces the upstream Elastos logo in the toolbar |
| `browser/index.html` | Adds the new stylesheets and welcome script |
| `browser/shell*.js`, `style.css` | Unchanged from upstream `home` — keeps the working window manager |

## Build

```sh
./build-wasm.sh           # produces hey_home.wasm next to capsule.json
```

Or, with the runtime's build helper:

```sh
elastos-runtime/scripts/build.sh hey-home
```

## Identity

On first boot Hey-Home renders a **setup wizard** with two paths:

### Recovery-key path
1. HeyMark intro + nickname input
2. **Generate my identity** → locally mints a 32-byte recovery key
   (`crypto.getRandomValues`) and derives a `did:key` from it (Ed25519
   multicodec `0xed01` + SHA-256 of the seed + base58btc — same shape
   as a real `did:key`, so any resolver will parse it)
3. Key card shows the recovery key + did:key, requires a "saved it"
   checkbox, drops into the desktop

### Passkey path (real WebAuthn)
1. Same nickname input
2. **Sign up with a passkey** → calls
   `navigator.credentials.create()` with Ed25519/ES256/RS256 in the
   `pubKeyCredParams`. The OS / authenticator (Yubikey, Touch ID,
   Windows Hello, Android keystore, …) generates the real keypair
   in hardware.
3. The credential ID, public key, transports, and a random
   `userHandle` are stored in the profile **alongside** a recovery
   key. The recovery key remains the fallback if the authenticator is
   lost.
4. Key card shows a green "Passkey enrolled" badge plus the recovery
   key + did:key.

The profile shape:

```jsonc
{
  "name": "EverlastingOS",
  "didKey": "did:key:z6Mk…",
  "recoveryKey": "<64 hex>",
  "passkeys": [
    {
      "id":          "<base64url credential id>",
      "publicKey":   "<base64url COSE public key>",
      "userHandle":  "<base64url 32-byte user handle>",
      "transports":  ["internal", "hybrid"],
      "createdAt":   "2026-05-26T…"
    }
  ],
  "createdAt": "2026-05-26T…"
}
```

It is persisted in the runtime's **localhost-provider** at

```
/api/localhost/Users/self/.AppData/LocalHost/HeyHome/profile.json
```

The node owns the file — it survives a browser cache wipe. `localStorage`
is used as a fallback (when the runtime isn't reachable, e.g. opening
`index.html` directly in a regular browser for design review) and as a
one-time migration source for users who set up before this change.

> Why localhost-provider and not IPFS? IPFS is content-addressed,
> immutable, and meant for **shared media** (post images, videos —
> things that should have the same CID for everyone). Profile data is
> private, mutable per-user state — wrong tool. The Hey app capsule
> uses localhost-provider too, in the parallel `LocalHost/Hey/`
> namespace.

### Lock screen (subsequent boots)
- Always shows the **Unlock** button (PIN-style dot animation → fade
  to desktop). This is still cosmetic — a real PIN gate is a future
  hardening pass.
- Shows **Use passkey** *only* if the profile has at least one
  credential **and** `window.PublicKeyCredential` exists. The button
  calls `navigator.credentials.get()` against the stored
  `allowCredentials` list. On success → unlock; on cancel/failure → a
  red inline error.

**Switch identity** in the bottom-right erases the local profile and
returns to first-run setup.

### Future work

- Hash (don't clear-store) the recovery key; verify against the hash
  on PIN-style unlock.
- COSE-decode `passkeys[i].publicKey` and verify the WebAuthn
  assertion signature locally — currently we trust the OS UV gesture.
- Share this profile with the Hey app capsule so the user doesn't
  have to sign up twice. Easiest path: have both capsules read from a
  shared identity namespace (e.g.
  `/api/localhost/Users/self/.AppData/Identity/profile.json`).
