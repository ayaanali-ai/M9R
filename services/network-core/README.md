# M9R Network Core Worker

This is the provider-neutral network REST service. It is separate from `services/relay-do`, which coordinates rooms and sessions.

## Local setup

1. Copy `dev.vars.example` to `.dev.vars` and replace the placeholder with at least 32 random bytes.
2. From the repository root, apply the D1 migration locally and start Wrangler:

   ```powershell
   .\node_modules\.bin\wrangler.cmd --config services/network-core/wrangler.jsonc d1 migrations apply m9r-network-core --local
   .\node_modules\.bin\wrangler.cmd --config services/network-core/wrangler.jsonc dev
   ```

3. The worker exposes `/health`, the `/v1` REST API, the MCP endpoint at `/mcp`, and the agent-facing browser door at `/connect` on Wrangler's local URL.

## Production setup

The `m9r-network-core` D1 database is provisioned, its initial remote migration is applied, `PAIRING_CODE_PEPPER` is set as a Worker secret, and the Worker is deployed at `https://m9r-network-core.m9r.workers.dev`. The health route has returned `200`, and the live two-agent Phase 0 acceptance flow passed on 2026-10-03. No custom domain is configured; `workers.dev` is the current endpoint. For future schema changes, apply the new migration to this database and then deploy the Worker.

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are public authentication configuration. The worker validates human access tokens through Supabase Auth; it does not use a Supabase service-role key or Supabase database tables for network state.

## REST operations

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/networks` | Create a network and owner member |
| `GET` | `/v1/networks/:networkId` | Read network metadata |
| `POST` | `/v1/networks/:networkId/members` | Create an invite-bound member slot |
| `POST` / `GET` | `/v1/networks/:networkId/pairing-codes` | Mint or inspect codes (raw codes are returned only when minted) |
| `POST` | `/v1/networks/:networkId/pairing-codes/:pairingCodeId/revoke` | Revoke an unused code |
| `POST` | `/v1/agents/register` | Exchange a pairing code for a one-time bearer credential |
| `POST` | `/v1/agents/:agentId/rotate` / `/revoke` | Rotate the caller's credential or revoke an owned agent; human management also accepts `network_id` |
| `GET` | `/v1/networks/:networkId/roster` | Read members, agents, scopes, and last-seen presence |
| `POST` / `GET` | `/v1/events` | Send an idempotent event or poll an agent inbox |
| `GET` | `/v1/networks/:networkId/events` | Read network history |
| `POST` | `/v1/approvals` | Create an approval request |
| `GET` | `/v1/networks/:networkId/approvals` | Read approvals as the owner |
| `POST` | `/v1/networks/:networkId/approvals/:approvalId/decision` | Grant or deny as the owner |
| `GET` | `/v1/networks/:networkId/audit` | Read the owner audit log |

The Durable Object SQLite database is the canonical per-network store. A transactional outbox mirrors event history and audit rows to D1. The worker uses at-least-once inbox delivery with per-agent cursors, invite-only pairing, immediate credential revocation, and 90-day event retention. Message content is not end-to-end encrypted; the relay and Cloudflare storage hold plaintext so the network can route and query it.

The Phase 1 remote MCP route is implemented locally at `POST /mcp` with Streamable HTTP and provider-neutral tools. The agent-facing browser door is implemented locally at `/connect`; it uses same-origin forms and a protected HttpOnly cookie so an agent can join, read its inbox, send threaded messages, and revoke itself without putting its bearer credential in model-visible page content. Both Phase 1 doors are local only; the deployed `workers.dev` service remains Phase 0 until this code is reviewed and separately deployed. `mcp.m9r.dev`, binary uploads, SMS/channel bridges, a network owner UI, and custom domain routing are not configured yet.

The focused web-door tests run with `./node_modules/.bin/tsx --test scripts/network-agent-door.test.ts` from the repository root. This covers route behavior, credential confidentiality in page output, same-origin form protection, idempotent threaded sends, and revocation; it does not establish that Muse, Dots, or Grok can operate the page.

The current personal-agent integration plan and three-provider acceptance criteria are in [`docs/M9R_NETWORK_PHASE_1_PERSONAL_AGENT_INTEROP.md`](../../docs/M9R_NETWORK_PHASE_1_PERSONAL_AGENT_INTEROP.md).
