# Mission ACP Bridge deployment

The Bridge is a long-running Render web service. It owns ACP sessions, polls
or subscribes to workspace messages, and exposes `/healthz` on the host-provided
`PORT`. The Render Blueprint at `/render.yaml` configures that endpoint as the
service health check so the platform restarts a crashed or unhealthy process.

Required deployment values are `MISSION_APP_PUBLIC_URL`,
`MISSION_RELAY_PUBLIC_URL`, `MISSION_RELAY_BRIDGE_TOKEN`,
`MISSION_WORKSPACE_ID`, and `MISSION_AGENT_TOKEN`. Provider credentials stay in
the ACP environment and are never logged or sent to the app API.

The Bridge keeps a bounded in-memory prompt queue and attempts to persist queue
overflow diagnostics through `/api/bridge/dead-letters`. The durable record
contains routing metadata and the failure reason, not the original task body.

Render's free plan may sleep or impose cold-start delay; use a paid always-on
plan before treating latency measurements as production performance.
