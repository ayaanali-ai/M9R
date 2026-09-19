import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { resolveEndpoint } from "@/lib/endpoint-service";
import { handleAgentError } from "../../_shared";

// GET /api/agent/endpoints/resolve?address=@codex: one endpoint, its reachability, presence and fidelity.
// Unknown and not-visible look the same (404). Bearer-authenticated; read-only.
const STATUS_BY_CODE = { ENDPOINT_NOT_FOUND: 404, AMBIGUOUS_ENDPOINT: 409, INVALID_ADDRESS: 400, HANDLES_NOT_AVAILABLE: 400 } as const;

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const address = req.nextUrl.searchParams.get("address");
    if (!address) return NextResponse.json({ error: "address is required.", code: "INVALID_ADDRESS" }, { status: 400 });
    const result = await resolveEndpoint(agent, address);
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) }, { status: STATUS_BY_CODE[result.code] });
    }
    return NextResponse.json({ endpoint: result.endpoint });
  } catch (err) {
    return handleAgentError(err);
  }
}
