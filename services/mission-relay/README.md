# Mission Relay service

Mission Relay is a long-running WebSocket process. It is intentionally separate
from the Next.js deployment because a serverless request handler cannot hold a
durable agent subscription.

## Required production environment

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MISSION_RELAY_TOKEN_SECRET` — at least 32 characters, stored only in the host secret manager
- `MISSION_RELAY_PUBLIC_URL` — the public `wss://` address used by Bridges and the dashboard
- `MISSION_RELAY_HOST` — normally `0.0.0.0`
- `MISSION_RELAY_PORT` or `PORT` — normally the host-provided port

Start it with:

```text
npm ci
npm run relay:start
```

The repository includes a Render Blueprint at `/render.yaml`. Choose “New
Blueprint” in Render, connect this repository, and enter the three prompted
environment values; Render generates the Relay signing secret automatically.
The Blueprint uses the free plan for validation and
configures `/healthz`; upgrade the service when the Relay must remain available
without free-tier sleep behavior.

Put a TLS-capable reverse proxy or managed WebSocket endpoint in front of the
process. The host must preserve WebSocket upgrades and forward the configured
port. Do not deploy this process as a Vercel serverless function.

## Acceptance gate

1. The process logs its bound host and port without printing credentials.
2. A Bridge authenticates with a workspace-scoped signed Relay token.
3. A subscribed browser receives a `mission.snapshot` and structured
   `runtime.event` frames.
4. A restart reconnects the Bridge and the browser can resume from its cursor.
