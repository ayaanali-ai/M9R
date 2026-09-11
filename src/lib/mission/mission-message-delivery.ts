export const DELIVERY_STATUSES = ["queued", "dispatched", "delivered", "acknowledged", "failed", "expired"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface MissionMessageDelivery {
  id: string;
  workspaceId: string;
  missionId: string;
  messageId: string;
  recipientParticipantId: string;
  bridgeInstanceId: string | null;
  agentSessionId: string | null;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export function expandMessageDeliveries(input: {
  idPrefix: string;
  workspaceId: string;
  missionId: string;
  messageId: string;
  senderParticipantId: string;
  recipientParticipantIds: readonly string[] | "mission_broadcast";
  activeRecipientIds: readonly string[];
  createdAt: string;
}): MissionMessageDelivery[] {
  const recipients = input.recipientParticipantIds === "mission_broadcast" ? input.activeRecipientIds : input.recipientParticipantIds;
  const uniqueRecipients = [...new Set(recipients)].filter((recipientId) => recipientId !== input.senderParticipantId);
  return uniqueRecipients.map((recipientId) => ({
    id: `${input.idPrefix}-${input.messageId}-${recipientId}`,
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    messageId: input.messageId,
    recipientParticipantId: recipientId,
    bridgeInstanceId: null,
    agentSessionId: null,
    status: "queued",
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deliveredAt: null,
    acknowledgedAt: null,
    failureCode: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }));
}

const TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  queued: ["dispatched", "failed", "expired"],
  dispatched: ["delivered", "failed", "expired"],
  delivered: ["acknowledged", "failed", "expired"],
  acknowledged: [],
  failed: ["dispatched", "expired"],
  expired: [],
};

export function advanceDelivery(delivery: MissionMessageDelivery, nextStatus: DeliveryStatus, now: string, failureCode: string | null = null): (MissionMessageDelivery & { ok: true }) | { ok: false; reason: string } {
  if (!TRANSITIONS[delivery.status].includes(nextStatus)) return { ok: false, reason: `Delivery cannot move from '${delivery.status}' to '${nextStatus}'.` };
  return {
    ...delivery,
    ok: true,
    status: nextStatus,
    attemptCount: nextStatus === "dispatched" ? delivery.attemptCount + 1 : delivery.attemptCount,
    lastAttemptAt: nextStatus === "dispatched" ? now : delivery.lastAttemptAt,
    deliveredAt: nextStatus === "delivered" ? now : delivery.deliveredAt,
    acknowledgedAt: nextStatus === "acknowledged" ? now : delivery.acknowledgedAt,
    failureCode: nextStatus === "failed" ? failureCode : delivery.failureCode,
    updatedAt: now,
  };
}
