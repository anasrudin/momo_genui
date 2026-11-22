<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Verification

- Type-check: `npx tsc --noEmit` (no ESLint in this project).
- Unit tests: `npx tsx --test $(find src -name '*.test.ts')` (91 tests).
- GenUI: every component and variant is rendered at `/playground` (dev server on `127.0.0.1:4173`); check both `data-theme` values.
- GenUI CSS (`mistline-genui.css`, `intelligence.css`, `intel-dataviz.css`) carries no `transition`; state changes go through `motion/react` (`StateMotion.tsx`). Only loading shimmers and spinners are CSS keyframes.
