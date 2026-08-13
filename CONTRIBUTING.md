# Contributing

Internal dev workflow. (The `README.md` is the npm-consumer-facing one — install/usage, not this.)

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm run build        # tsup
npm run test          # vitest run
```

Run `npm run typecheck` before every commit — it's the fastest signal something broke.

## Branch protection (both `vio-web-sdk` and `vev` — 2026-08-13)

`main` on both repos requires a PR to merge — **direct pushes are blocked for everyone,
admins included.** This exists because of repeated collisions: someone edits/deploys
straight to `main` while someone else is mid-change, and one side silently overwrites
the other.

Workflow for every change, however small:

```bash
git checkout -b <name>/<short-description>   # e.g. alan/vipps-status-query
git commit -m "…"
git push -u origin <branch>
gh pr create --fill
gh pr merge --squash        # no approval required (required_approving_review_count: 0) —
                             # merge your own PR once it's up, no need to wait on anyone
```

No CI is configured, so nothing blocks the merge except opening the PR itself — this is
about **visibility and avoiding silent overwrites**, not gatekeeping.

## Never hand-edit the vendored bundle

`vio-vev/vio-sdk/index.js` is a **generated artifact** — a pure `esbuild` bundle of this
repo's `src/`. It must never be edited by hand. If you find yourself patching something
in that file directly, stop: make the same change in `src/` here instead, then rebundle:

```bash
cd vio-web-sdk
npx esbuild src/_vev-entry.ts --bundle --format=esm \
  --external:react --external:react-dom \
  --tsconfig=tsconfig.json \
  --outfile=../vio-vev/vio-sdk/index.js
```

Commit the regenerated `vio-sdk/index.js` in the `vev` repo alongside (or right after)
your `vio-web-sdk` PR merges — same branch/PR workflow applies there too.

Hand-editing the bundle has caused real regressions before (fixes silently reverted,
inconsistent behavior between what's in `src/` and what's actually deployed) — always
prefer editing `src/` even if it takes a few minutes longer.

## Publishing to Vev

`cd vio-vev && npx vev deploy` publishes the package (`cq1lXld-TA9`) live — this has no
lock; the last deploy wins over whatever was published before, regardless of who deployed
it or whether it matches what's in git. Before deploying:

1. `git pull` in both repos — make sure you're building from the latest merged state, not
   a stale local checkout.
2. Confirm the bundle you're about to publish matches what's actually in `vio-vev/main`
   (i.e. you didn't leave local edits uncommitted).
3. If you're not sure whether someone else just deployed, check the live version first:
   `npx vev versions` (or ask before publishing) — a wrong assumption here is how we've
   overwritten each other's work in the past.
