import { NextRequest, NextResponse } from "next/server";
import { uploadDashboardConversationAttachment } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const messageId = form?.get("messageId");
  if (!(file instanceof File) || typeof messageId !== "string" || !messageId) {
    return NextResponse.json({ error: "file and messageId are required." }, { status: 400 });
  }
  try {
    const attachment = await uploadDashboardConversationAttachment({ conversationId: id, messageId, file });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
