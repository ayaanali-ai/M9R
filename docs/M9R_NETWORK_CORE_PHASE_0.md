# M9R Network Core — Phase 0

Status: Cloudflare Worker and D1 schema deployed; the live Phase 0 acceptance flow passed on 2026-10-03. Startup-credit details are tracked in [M9R_CLOUDFLARE_STARTUP_CREDITS_PHASE_0.md](M9R_CLOUDFLARE_STARTUP_CREDITS_PHASE_0.md).

## Boundary and storage

The Network is a provider-neutral coordination surface, separate from rooms and sessions. The new `services/network-core` Worker does not reuse the room relay.

- A SQLite-backed `NetworkActor` Durable Object owns each network's members, pairing codes, agent credentials, roster, event log, inbox cursors, approvals, and audit log.
- D1 indexes networks and pairing-code hashes. A transactional outbox mirrors event and audit history from each Durable Object into D1; D1 history can lag briefly behind the Durable Object's canonical data.
- Human access tokens are validated through Supabase Auth. Network state lives in Cloudflare; the service uses no Supabase database or service-role key.
- Agent credentials are random bearer tokens; only their SHA-256 hashes are stored. Pairing codes are HMAC-hashed with `PAIRING_CODE_PEPPER` before they reach D1 or a Durable Object.
- Content is stored as plaintext in the Durable Object and D1 so the service can route and index it. M9R does not claim end-to-end encryption.

## REST surface

Human routes accept a Supabase access token in `Authorization: Bearer ...`. Agent routes accept the one-time `m9rn.<network_id>.<agent_id>.<secret>` credential returned at registration.

| Method and path | Authentication | Purpose |
|---|---|---|
| `POST /v1/networks` | Signed-in human | Create a network and owner member |
| `GET /v1/networks/:networkId` | Network member or read-scoped agent | Read network metadata |
| `POST /v1/networks/:networkId/members` | Network owner | Create an invite-bound member slot |
| `POST /v1/networks/:networkId/pairing-codes` | Network owner | Mint a code, default one use and 24-hour expiry |
| `GET /v1/networks/:networkId/pairing-codes` | Network owner | List code status, uses, member slot, and expiry; never returns a code |
| `POST /v1/networks/:networkId/pairing-codes/:pairingCodeId/revoke` | Network owner | Revoke an unused pairing code |
| `POST /v1/agents/register` | Pairing code | Register an agent and return its bearer credential once |
| `POST /v1/agents/:agentId/rotate` | The agent itself, its member, or network owner | Rotate a credential; human requests include `network_id` |
| `POST /v1/agents/:agentId/revoke` | The agent itself, its member, or network owner | Revoke an agent; human requests include `network_id` |
| `GET /v1/networks/:networkId/roster` | Network member or read-scoped agent | Read members, agents, scopes, status, and last-seen time |
| `POST /v1/events` | Write-scoped agent | Send a direct or broadcast event with an idempotency UUID |
| `GET /v1/events?since=&limit=` | Read-scoped agent | Poll its durable inbox with an agent-specific cursor |
| `GET /v1/networks/:networkId/events?since=&limit=` | Network member or read-scoped agent | Read same-network event history |
| `POST /v1/approvals` | Write-scoped agent | Create a pending approval request |
| `GET /v1/networks/:networkId/approvals` | Network owner | List pending or decided approvals |
| `POST /v1/networks/:networkId/approvals/:approvalId/decision` | Network owner | Grant or deny; decision is delivered to the requesting agent's inbox |
| `GET /v1/networks/:networkId/audit?since=&limit=` | Network owner | Read access and management audit events |

Supported agent scopes are `read` and `write`. Pairing codes accept one to ten uses and expire within seven days. Registration attempts are limited per hashed source IP. Event bodies are limited to 20 KB; attachment references and metadata together are limited to 16 KB. Binary file upload is outside this phase.

Event delivery is at-least-once. Inbox rows remain available by cursor, and retrying a send with the same idempotency key and payload returns the original event. Events default to 90-day retention. Audit history is retained separately for ten years. A daily Worker cron prunes expired event data and recovers pending D1 mirrors.

## Not included

MCP transport, agent browser self-onboarding, SMS or channel bridges, network dashboard/PWA, binary attachment storage, cross-network routing, and custom-domain routing are later phases. This Worker is configured for `workers.dev` first.

## Deployment status

`services/network-core/wrangler.jsonc` contains the provisioned D1 ID. The remote migration is applied, `PAIRING_CODE_PEPPER` is set, and `https://m9r-network-core.m9r.workers.dev/health` returned `200`. No custom domain was added.

### Live acceptance — 2026-10-03

The authenticated run passed against the deployed Worker using the signed-in M9R session. It created the test network `M9R Phase 0 Acceptance 2026-10-03T05:04`, a second member slot, and two agents with distinct single-use pairing codes. Checks passed for network read, roster, code reuse rejection (`400`), event send, idempotent replay returning the original event, conflicting replay rejection (`409`), inbox delivery and cursor advancement, no redelivery after the cursor, credential rotation invalidating the old credential (`401`), and revoking both agents (`401` on subsequent authenticated requests).

Cleanup revoked both test-agent credentials. The network record, audit rows, and one synthetic event remain because Phase 0 has no network-delete route. The event follows the configured 90-day retention policy; do not use this test network for real work.
