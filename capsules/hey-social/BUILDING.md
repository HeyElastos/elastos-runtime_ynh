# Building hey-social

Source lives in `source/`. Vite builds output back into this directory
(next to `capsule.json`) so the runtime serves the built bundle directly
without a copy step.

```bash
cd source
npm install   # first time + after package.json changes
npm run build # rebuilds index.html + assets/ in the capsule root
```

What gets touched by `npm run build`:

- `index.html` — overwritten (Vite entry → built page)
- `assets/` — overwritten (Vite hashed JS/CSS/etc.)
- `hey-icon.svg` — copied from `source/public/hey-icon.svg` (Vite copies
  the `public/` tree)

What stays untouched:

- `capsule.json` — Vite never writes outside the file types it emits
- `BUILDING.md`, this file
- `source/` — Vite builds *out of* this dir, not into it

`source/node_modules/` and `source/dist/` are in `source/.gitignore`.
The built assets at the capsule root ARE committed so a fresh
`yunohost app install` ships a ready-to-serve capsule without needing
node on the box.

## Why not just commit unbuilt source and build at install time?

YunoHost installs run as the app user with a constrained PATH and no
network access at certain steps. Adding a Node toolchain to the install
pipeline triples cold-install time + adds a moving dep we'd have to
vendor. The current model — commit the built capsule, rebuild in this
tree before each release — keeps installs fast and predictable.
