import { NextResponse } from "next/server";
import { adapterContractManifest } from "@/lib/adapter-contract";

/**
 * GET /api/agent/contract — the generic adapter contract manifest.
 *
 * Deliberately unauthenticated: an adapter needs to discover what OathLock
 * supports before it has a token, and this document contains no workspace or
 * user data, only the static list of known protocol actions.
 */
export async function GET() {
  return NextResponse.json(adapterContractManifest());
}
