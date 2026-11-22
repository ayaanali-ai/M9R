<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# M9R build / update / install flow

Before building, updating, or installing M9R (not the Next.js app above —
the desktop-agent product itself), read [`BUILD_INSTALL_FLOW.md`](./BUILD_INSTALL_FLOW.md)
in this same folder. It documents the locked, code-enforced flow (one
build folder, one trunk branch, no dirty-tree builds, the pill always
compiled from source, installs only from a tagged release) and is the
canonical reference for any agent working on this repo's build/install
scripts.
