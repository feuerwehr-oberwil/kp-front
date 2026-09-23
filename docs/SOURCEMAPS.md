# Reading a production stack (sourcemaps)

A field crash reaches the server log as one `kpfront.clienterror` line (`api/diag.py`), e.g.

```
client-error kind=render build=v0.11.0+cb80695 srv=0.11.0 surface=map path=/ ua=… :: Minified React error #185 … :: stack: Error: Minified React error #185 ⏎     at Xe (index-CsmMbkFb.js:37:36628) ⏎ … :: componentStack:     at Ye (index-CsmMbkFb.js:37:1201) ⏎ …
```

The stack is minified. Since 24.09.2026 every build writes **hidden sourcemaps**
(`vite.config.ts · build.sourcemap: 'hidden'`): a `.map` beside every chunk in `dist/assets`,
referenced by no bundle (no `sourceMappingURL`), precached by no service worker, and shipped in
the image, where `/assets/` serves them beside the chunks. The repo is public, so the maps are
no secret; they are hidden only so that no browser and no tablet ever loads them.
`scripts/check-sourcemaps.mjs` (CI, after `pnpm build`) holds all three facts.

`build=` is the build **that threw**, `srv=` the server's. They differ when a tablet has not
restarted since a deploy: symbolicate against `build=`, never against what is deployed now.

## Symbolicate

`scripts/symbolicate.mjs` (no dependencies) reads the stack, and understands the « ⏎ » the
log writes for a newline, so a log line can be pasted as it is:

```bash
# 1. The build is still deployed: take the maps from the server.
pbpaste | node scripts/symbolicate.mjs https://front.fwo.li

# 2. It is not (a deploy since): rebuild that commit the way the image does — from an export
#    without .git, with the 7-character sha from `build=` — and use the local maps.
sha=cb80695
rm -rf /tmp/sym && mkdir /tmp/sym && git archive "$sha" | tar -x -C /tmp/sym
(cd /tmp/sym && pnpm install --frozen-lockfile && GIT_SHA="$sha" pnpm build)
node scripts/symbolicate.mjs /tmp/sym/dist/assets stack.txt
```

Each frame gets `→ src/…/File.tsx:line:col (name)` appended.

⚠️ A rebuild gives the chunks **different names** (`index-CsmMbkFb.js` → `index-DcTipmoD.js`):
the build time is baked into the bundle and the hash follows the bytes. The positions are the
same, because that timestamp has a fixed length, so the script matches a chunk by its name
without the hash and says so on stderr. Two things break this, and both change the length of
a baked string:
- building from a git checkout. `vite.config.ts` then asks git for the short sha, which can be
  8 characters where the image had 7. Use `git archive` and `GIT_SHA` as above.
- a different lockfile resolution. `--frozen-lockfile` prevents it.

The component stack needs a map as well. The minifier renames components, so a production
build writes `at Xe (…/assets/index-….js:37:1234)` and not `at TwinTeamPill`. React 19 gives
each frame a position, and the same script resolves them. Symbolicate the component stack
first: its top frames name the component that threw, and for React #185 ("Maximum update
depth") the JS stack only shows react-dom internals.
