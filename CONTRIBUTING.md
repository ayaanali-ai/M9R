# Contributing to M9R

Thanks for helping improve M9R. Start with an issue for substantial changes so
the scope and open-core boundary are clear before implementation.

## Local checks

Use Node.js 20 or newer and npm:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Changes to `packages/runtime-core` should also pass:

```bash
npm run build:runtime-core
npm run test:runtime-core
```

## Pull requests

- Keep provider credentials, service-role keys, and local CLI state out of
  commits.
- Explain user-visible behavior and include verification steps.
- Do not present provider availability or live-agent completion as guaranteed.
- Preserve the license boundary and read `OPEN_CORE.md` before changing package
  ownership or licensing.
- Do not use the M9R name or marks in a derivative product without reviewing
  `TRADEMARK_POLICY.md`.
