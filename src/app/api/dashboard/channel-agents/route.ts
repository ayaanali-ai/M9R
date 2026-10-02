import {NextRequest,NextResponse} from "next/server";
import {listChannelAgentRoster,changeChannelAgent} from "@/lib/conversation-service";
import {handleDashboardApiError} from "../_shared";
export async function GET(req:NextRequest) {
 const id=req.nextUrl.searchParams.get("conversationId");
 if(!id) return NextResponse.json({error:"conversationId is required."},{status:400});
 try {return NextResponse.json(await listChannelAgentRoster(id),{headers:{"cache-control":"no-store"}});}catch(error){return handleDashboardApiError(error);}
}
export async function PATCH(req:NextRequest) {
 const body=await req.json().catch(()=>null);
 if(!body || typeof body.conversationId!=="string" || typeof body.connectionId!=="string" || typeof body.add!=="boolean")return NextResponse.json({error:"Invalid membership change."},{status:400});
 try {await changeChannelAgent(body.conversationId,body.connectionId,body.add);return NextResponse.json({ok:true});}catch(error){return handleDashboardApiError(error);}
}
