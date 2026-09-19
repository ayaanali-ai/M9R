# M9R Cloudflare Staging — Per-Service Environment & Secret Matrix

Generated from actual source code usage (`process.env.*` in each service).

---

## Classification Legend
- **SECRET** — Never in wrangler.jsonc; set via `wrangler secret put` or dashboard
- **PUBLIC CONFIG** — Safe in wrangler.jsonc `vars`; no rotation needed
- **PRIVATE CONFIG** — Safe in wrangler.jsonc `vars` but deployment-specific

---

## Mission Relay (m9r-relay-staging)

| Variable | Classification | Source | Notes |
|----------|---------------|--------|-------|
| `MISSION_RELAY_TOKEN_SECRET` | **SECRET** | `config.ts:11`, `server.ts:15` | ≥32 chars; used for internal `/internal/*` auth |
| `NEXT_PUBLIC_SUPABASE_URL` | PUBLIC CONFIG | `config.ts:13` | |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** | `config.ts:14` | |
| `MISSION_RELAY_PUBLIC_URL` | PUBLIC CONFIG | `config.ts:18` | `wss://...` |
| `MISSION_RELAY_HOST` | PRIVATE CONFIG | `config.ts:17` | Default `0.0.0.0` |
| `MISSION_RELAY_PORT` / `PORT` | PRIVATE CONFIG | `config.ts:15` | Default `8787` → Container uses `8080` |

**Worker → Container envVars (least privilege):**
```
MISSION_RELAY_TOKEN_SECRET        → SECRET (required)
NEXT_PUBLIC_SUPABASE_URL          → PUBLIC CONFIG
SUPABASE_SERVICE_ROLE_KEY         → SECRET
MISSION_RELAY_PUBLIC_URL          → PUBLIC CONFIG
MISSION_RELAY_HOST                → "0.0.0.0"
MISSION_RELAY_PORT                → "8080"
```

---

## Mission Worker (m9r-worker-staging)

| Variable | Classification | Source | Notes |
|----------|---------------|--------|-------|
| `MISSION_WORKER_ENABLED` | PRIVATE CONFIG | `index.ts:49` | Must be `"true"` |
| `MISSION_RUNTIME_EVENTS_ENABLED` | PRIVATE CONFIG | `index.ts:53` | Must be `"true"` |
| `MISSION_RELAY_PUBLIC_URL` | PUBLIC CONFIG | `index.ts:90` | Cloudflare Relay WSS URL |
| `MISSION_RELAY_BRIDGE_TOKEN` | **SECRET** | `index.ts:93` | Relay client credential |
| `MISSION_WORKSPACE_IDS` | PRIVATE CONFIG | `index.ts:55` | Comma-separated; staging-only |
| `MISSION_REPOSITORY_ROOT` | PRIVATE CONFIG | `index.ts:58` | `/workspace/repo` |
| `MISSION_REPOSITORY_ID` | PRIVATE CONFIG | `index.ts:58` | Optional |
| `MISSION_WORKER_REQUIRED_CAPABILITIES` | PRIVATE CONFIG | `index.ts:42` | Optional |
| `MISSION_WORKER_HOST_ID` | PRIVATE CONFIG | `index.ts:85` | Optional |
| `MISSION_WORKER_CANDIDATE_BATCH_SIZE` | PRIVATE CONFIG | `index.ts:119` | Default `25` |
| `MISSION_WORKER_POLL_INTERVAL_MS` | PRIVATE CONFIG | `index.ts:120` | Default `5000` |
| `NEXT_PUBLIC_SUPABASE_URL` | PUBLIC CONFIG | `index.ts:52` | |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** | `index.ts:52` | |

**NOT used by Worker (do NOT pass):**
- ❌ `MISSION_RELAY_TOKEN_SECRET` — only Relay uses this for internal auth

**Worker → Container envVars (least privilege):**
```
MISSION_WORKER_ENABLED                → "true"
MISSION_RUNTIME_EVENTS_ENABLED        → "true"
MISSION_RELAY_PUBLIC_URL              → PUBLIC CONFIG (staging Relay WSS)
MISSION_RELAY_BRIDGE_TOKEN            → SECRET
MISSION_WORKSPACE_IDS                 → PRIVATE CONFIG (staging only)
MISSION_REPOSITORY_ROOT               → "/workspace/repo"
MISSION_REPOSITORY_ID                 → PRIVATE CONFIG (optional)
MISSION_WORKER_REQUIRED_CAPABILITIES  → PRIVATE CONFIG (optional)
MISSION_WORKER_HOST_ID                → PRIVATE CONFIG (optional)
MISSION_WORKER_CANDIDATE_BATCH_SIZE   → "25"
MISSION_WORKER_POLL_INTERVAL_MS       → "5000"
NEXT_PUBLIC_SUPABASE_URL              → PUBLIC CONFIG
SUPABASE_SERVICE_ROLE_KEY             → SECRET
```

---

## Mission Bridge (m9r-bridge-staging)

| Variable | Classification | Source | Notes |
|----------|---------------|--------|-------|
| `ACP_BRIDGE_ENABLED` | PRIVATE CONFIG | `index.ts:19` | Must be `"true"` |
| `MISSION_DEV_MCP_TOOLS_ENABLED` | PRIVATE CONFIG | `index.ts:28` | Default `"true"` |
| `MISSION_ACP_SESSIONS_JSON` | PRIVATE CONFIG | `index.ts:33` | Optional |
| `PORT` | PRIVATE CONFIG | `index.ts:56` | Container uses `8080` |
| `MISSION_BRIDGE_INSTANCE_ID` | PRIVATE CONFIG | `index.ts:64` | Optional |
| `MISSION_REPOSITORY_ROOT` | PRIVATE CONFIG | `index.ts:65` | `/workspace/repo` |
| `MISSION_REPOSITORY_ID` | PRIVATE CONFIG | `index.ts:66` | Optional |
| `MISSION_WORKSPACE_ID` | PRIVATE CONFIG | `index.ts:59` | Staging-only |
| `MISSION_APP_PUBLIC_URL` | PUBLIC CONFIG | `index.ts:59` | Staging website URL |
| `MISSION_RELAY_PUBLIC_URL` | PUBLIC CONFIG | `index.ts:61` | Cloudflare Relay WSS URL |
| `MISSION_RELAY_BRIDGE_TOKEN` | **SECRET** | `index.ts:61` | Relay client credential |
| `MISSION_AGENT_TOKEN` | **SECRET** | `index.ts:63` | Agent auth |

**NOT used by Bridge (do NOT pass):**
- ❌ `MISSION_RELAY_TOKEN_SECRET` — only Relay uses this for internal auth

**Bridge → Container envVars (least privilege):**
```
ACP_BRIDGE_ENABLED                  → "true"
MISSION_DEV_MCP_TOOLS_ENABLED       → "true"
MISSION_ACP_SESSIONS_JSON           → PRIVATE CONFIG (optional)
MISSION_WORKSPACE_ID                → PRIVATE CONFIG (staging only)
MISSION_APP_PUBLIC_URL              → PUBLIC CONFIG (staging website)
MISSION_RELAY_PUBLIC_URL            → PUBLIC CONFIG (staging Relay WSS)
MISSION_RELAY_BRIDGE_TOKEN          → SECRET
MISSION_AGENT_TOKEN                 → SECRET
MISSION_REPOSITORY_ROOT             → "/workspace/repo"
MISSION_REPOSITORY_ID               → PRIVATE CONFIG (optional)
PORT                                → "8080"
```

---

## Website (m9r-web-staging)

| Variable | Classification | Notes |
|----------|---------------|-------|
| `NEXT_PUBLIC_SITE_URL` | PUBLIC CONFIG | `https://m9r-web-staging.m9r.workers.dev` |
| `NEXT_PUBLIC_SUPABASE_URL` | PUBLIC CONFIG | |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | PUBLIC CONFIG | |
| `MISSION_RELAY_PUBLIC_URL` | PUBLIC CONFIG | `wss://m9r-mission-relay.onrender.com` (current) → will switch to staging Relay |
| `NEXT_PUBLIC_M9R_BILLING_ENABLED` | PRIVATE CONFIG | `"false"` |
| `NEXT_PUBLIC_M9R_TERMINAL_ENABLED` | PRIVATE CONFIG | `"true"` |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** | |
| `MISSION_RELAY_TOKEN_SECRET` | **SECRET** | For `/api/missions/relay-token` |
| `MISSION_RELAY_BRIDGE_TOKEN` | **SECRET** | If website calls internal Relay endpoints |
| `STRIPE_SECRET_KEY` | **SECRET** | If billing enabled |
| `STRIPE_WEBHOOK_SECRET` | **SECRET** | If billing enabled |
| `RESEND_API_KEY` | **SECRET** | If email enabled |
| `VAPID_PRIVATE_KEY` | **SECRET** | If push enabled |
| `CRON_SECRET` | **SECRET** | Internal cron auth |

---

## Secret Name Mapping (Worker Secret → Container envVar)

| Worker Secret Name | Relay Container | Worker Container | Bridge Container |
|---|---|---|---|
| `MISSION_RELAY_TOKEN_SECRET` | ✅ `MISSION_RELAY_TOKEN_SECRET` | ❌ | ❌ |
| `MISSION_RELAY_BRIDGE_TOKEN` | ❌ | ✅ `MISSION_RELAY_BRIDGE_TOKEN` | ✅ `MISSION_RELAY_BRIDGE_TOKEN` |
| `MISSION_AGENT_TOKEN` | ❌ | ❌ | ✅ `MISSION_AGENT_TOKEN` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ `SUPABASE_SERVICE_ROLE_KEY` | ✅ `SUPABASE_SERVICE_ROLE_KEY` | ❌ |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ (public) | ✅ (public) | ❌ |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ❌ | ❌ | ❌ |
| `NEXT_PUBLIC_SITE_URL` | ❌ | ❌ | ❌ |
| `MISSION_RELAY_PUBLIC_URL` | ✅ (public) | ✅ (public) | ✅ (public) |
| `MISSION_APP_PUBLIC_URL` | ❌ | ❌ | ✅ (public) |
| `MISSION_WORKSPACE_ID` / `MISSION_WORKSPACE_IDS` | ❌ | ✅ | ✅ |

---

## Instance Types (wrangler.jsonc)

| Service | Instance Type | vCPU | Memory | Disk |
|---------|--------------|------|--------|------|
| Mission Relay | `standard-1` | 0.5 | 4 GiB | 8 GB |
| Mission Worker | `standard-2` | 1 | 6 GiB | 12 GB |
| Mission Bridge | `standard-2` | 1 | 6 GiB | 12 GB |

---

## Fixed Container IDs

| Environment | Relay | Worker | Bridge |
|-------------|-------|--------|--------|
| Staging | `m9r-relay-staging` | `m9r-worker-staging` | `m9r-bridge-staging` |
| Production | `m9r-relay-production` | `m9r-worker-production` | `m9r-bridge-production` |

---

## Lifecycle Configuration

All three containers:
```typescript
sleepAfter = "24h";

override async onActivityExpired(): Promise<void> {
  // Do not call stop()/destroy() - keeps container alive indefinitely
  // Per Cloudflare docs: returning without stopping renews the timer
}
```

This overrides the default 10-minute idle shutdown for stateful services.

---

## Deployment Prerequisites

1. **Docker Desktop** installed and running
2. **Secrets set** via `wrangler secret put --env staging` or dashboard
3. **Staging workspace ID** created in Supabase for isolation
4. **Docker Hub / Cloudflare registry** access for image push