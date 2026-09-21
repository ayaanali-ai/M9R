import { NextRequest, NextResponse } from "next/server";
import { authorizedStaticBearer } from "@/lib/request-security";
import { createProductionMissionRelayOptions } from "@/lib/mission/mission-relay-production";
import type { MissionRelayServiceOptions } from "@/lib/mission/mission-relay-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Database and product logic for the Durable Object Relay.
 *
 * The Relay Worker owns sockets and routing only. Everything that needs Supabase or product rules
 * (authentication, channel authorization, snapshots, message persistence and its side effects) stays
 * here and is reached over a Cloudflare service binding. Each op maps 1:1 onto a function in
 * `createProductionMissionRelayOptions`, so behavior is identical to the container Relay.
 *
 * Authenticated with RELAY_INTERNAL_SECRET (never the token-signing secret). Not reachable from a
 * browser: no cookie session is consulted, and the shared guard already rejects cookie-bearing
 * cross-site writes.
 */

const OPS = [
  "authenticate",
  "loadMissionSnapshot",
  "loadWorkspaceSnapshot",
  "postMessage",
  "postWorkspaceMessage",
  "receiveWorkspaceTiming",
  "acknowledgeDelivery",
  "receiveRuntimeEvent",
  "receiveBridgeHeartbeat",
  "resolvePtyOwnerHuman",
] as const;
type RelayRpcOp = (typeof OPS)[number];

let cached: { secret: string; options: MissionRelayServiceOptions } | null = null;
function relayOptions(): MissionRelayServiceOptions | null {
  const secret = process.env.MISSION_RELAY_TOKEN_SECRET?.trim();
  if (!secret) return null;
  if (!cached || cached.secret !== secret) cached = { secret, options: createProductionMissionRelayOptions({ tokenSecret: secret }) };
  return cached.options;
}

async function dispatch(options: MissionRelayServiceOptions, op: RelayRpcOp, input: unknown): Promise<unknown> {
  switch (op) {
    case "authenticate": return options.authenticator.authenticate(input as Parameters<MissionRelayServiceOptions["authenticator"]["authenticate"]>[0]);
    case "loadMissionSnapshot": return options.loadMissionSnapshot(input as Parameters<MissionRelayServiceOptions["loadMissionSnapshot"]>[0]);
    case "loadWorkspaceSnapshot": return options.loadWorkspaceSnapshot ? options.loadWorkspaceSnapshot(input as Parameters<NonNullable<MissionRelayServiceOptions["loadWorkspaceSnapshot"]>>[0]) : null;
    case "postMessage": return options.postMessage ? options.postMessage(input as Parameters<NonNullable<MissionRelayServiceOptions["postMessage"]>>[0]) : null;
    case "postWorkspaceMessage": return options.postWorkspaceMessage ? options.postWorkspaceMessage(input as Parameters<NonNullable<MissionRelayServiceOptions["postWorkspaceMessage"]>>[0]) : null;
    case "receiveWorkspaceTiming": await options.receiveWorkspaceTiming?.(input as Parameters<NonNullable<MissionRelayServiceOptions["receiveWorkspaceTiming"]>>[0]); return null;
    case "acknowledgeDelivery": await options.acknowledgeDelivery?.(input as Parameters<NonNullable<MissionRelayServiceOptions["acknowledgeDelivery"]>>[0]); return null;
    case "receiveRuntimeEvent": return options.receiveRuntimeEvent ? options.receiveRuntimeEvent(input as Parameters<NonNullable<MissionRelayServiceOptions["receiveRuntimeEvent"]>>[0]) : null;
    case "receiveBridgeHeartbeat": await options.receiveBridgeHeartbeat?.(input as Parameters<NonNullable<MissionRelayServiceOptions["receiveBridgeHeartbeat"]>>[0]); return null;
    case "resolvePtyOwnerHuman": {
      const value = input && typeof input === "object" && "agentConnectionId" in input
        ? (input as { agentConnectionId?: unknown }).agentConnectionId
        : input;
      return options.resolvePtyOwnerHuman ? options.resolvePtyOwnerHuman(String(value ?? "")) : null;
    }
  }
}

export async function POST(request: NextRequest) {
  if (!authorizedStaticBearer(request, process.env.RELAY_INTERNAL_SECRET?.trim())) {
    return NextResponse.json({ ok: false, error: { message: "unauthorized" } }, { status: 401 });
  }
  const options = relayOptions();
  if (!options) return NextResponse.json({ ok: false, error: { message: "Relay is not configured." } }, { status: 503 });

  let body: { op?: unknown; input?: unknown };
  try {
    body = await request.json() as { op?: unknown; input?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: { message: "invalid json" } }, { status: 400 });
  }
  const op = body.op as RelayRpcOp;
  if (!OPS.includes(op)) return NextResponse.json({ ok: false, error: { message: "unknown op" } }, { status: 400 });

  try {
    const result = await dispatch(options, op, body.input);
    return NextResponse.json({ ok: true, result: result ?? null });
  } catch (error) {
    // A failed op is a normal outcome (bad credential, forbidden channel...): the Relay turns the message
    // into the same relay.error the container Relay would have sent, so this is 200 with ok:false.
    return NextResponse.json({ ok: false, error: { message: error instanceof Error ? error.message : "Relay request failed." } });
  }
}
