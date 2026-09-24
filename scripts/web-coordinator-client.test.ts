import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleCoordinatorSession,
  createCoordinatorIdentity,
  createCoordinatorSessionDescriptor,
  createCoordinatorNodeClient,
  createSealedCoordinatorEnvelope,
  openSealedCoordinatorEnvelope,
  signCoordinatorSession,
  verifyCoordinatorEnvelopeLocal,
  verifyCoordinatorPollLocal,
  verifyCoordinatorSessionLocal,
} from "@/lib/native/web-coordinator-client";
import type { CoordinatorPollRequest, SignedCoordinatorEnvelope, SignedCoordinatorSession } from "@/lib/native/web-coordinator-protocol";

test("session establishment requires valid signatures from both pinned owner keys", async () => {
  const alice = createCoordinatorIdentity();
  const bob = createCoordinatorIdentity();
  const descriptor = createCoordinatorSessionDescriptor("session-1", [alice.member, bob.member], 10_000, 20_000);
  const signed = assembleCoordinatorSession(descriptor, [signCoordinatorSession(alice, descriptor), signCoordinatorSession(bob, descriptor)]);
  assert.equal(verifyCoordinatorSessionLocal(signed, 10_000).ok, true);
  assert.equal(verifyCoordinatorSessionLocal({ ...signed, acceptances: signed.acceptances.slice(0, 1) }, 10_000).ok, false);
  assert.equal(verifyCoordinatorSessionLocal({ ...signed, descriptor: { ...descriptor, expiresAt: 21_000 } }, 10_000).ok, false);
});

test("node-to-node payloads are sealed, metadata-signed, and reject tampering", async () => {
  const alice = createCoordinatorIdentity();
  const bob = createCoordinatorIdentity();
  const descriptor = createCoordinatorSessionDescriptor("session-2", [alice.member, bob.member], 10_000, 20_000);
  const signed = assembleCoordinatorSession(descriptor, [signCoordinatorSession(alice, descriptor), signCoordinatorSession(bob, descriptor)]);
  const frame = createSealedCoordinatorEnvelope(alice, bob.member, descriptor, "web.command", 1, { action: "click", selector: "button.submit" }, 10_000);
  assert.doesNotMatch(frame.sealedPayload, /button\.submit|click/);
  assert.equal(verifyCoordinatorEnvelopeLocal(signed, frame, 10_000).ok, true);
  assert.deepEqual(openSealedCoordinatorEnvelope(bob, alice.member, descriptor, frame), { action: "click", selector: "button.submit" });
  assert.equal(verifyCoordinatorEnvelopeLocal(signed, { ...frame, sequence: 2 }, 10_000).ok, false);
  assert.throws(() => openSealedCoordinatorEnvelope(bob, alice.member, descriptor, { ...frame, sealedPayload: frame.sealedPayload.slice(0, -2) + "ab" }));
});

test("the node client signs registration, sends only opaque envelopes, and decrypts received frames", async () => {
  const alice = createCoordinatorIdentity();
  const bob = createCoordinatorIdentity();
  const descriptor = createCoordinatorSessionDescriptor("session-3", [alice.member, bob.member], 10_000, 20_000);
  const signed = assembleCoordinatorSession(descriptor, [signCoordinatorSession(alice, descriptor), signCoordinatorSession(bob, descriptor)]);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let registered: SignedCoordinatorSession | undefined;
  let lastSequence = 0;
  let queue: SignedCoordinatorEnvelope[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/register")) {
      const checked = verifyCoordinatorSessionLocal(body, 10_000);
      if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
      registered = checked.session;
      return Response.json({ ok: true });
    }
    if (!registered) return Response.json({ error: "session missing" }, { status: 404 });
    if (url.pathname.endsWith("/frames")) {
      const checked = verifyCoordinatorEnvelopeLocal(registered, body, 10_000);
      const sequence = (body as { sequence?: number }).sequence;
      if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
      if (!sequence || sequence <= lastSequence) return Response.json({ error: "sequence replay" }, { status: 409 });
      lastSequence = sequence;
      queue.push(checked.frame);
      return Response.json({ ok: true, accepted: true });
    }
    if (url.pathname.endsWith("/poll")) {
      const poll = body as unknown as CoordinatorPollRequest;
      if (!verifyCoordinatorPollLocal(registered, poll, 10_000)) return Response.json({ error: "poll signature is invalid" }, { status: 401 });
      const frames = queue.filter((frame) => frame.toOwner === poll.ownerId);
      queue = queue.filter((frame) => frame.toOwner !== poll.ownerId);
      return Response.json({ ok: true, frames });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  const client = createCoordinatorNodeClient(alice, { endpoint: "http://127.0.0.1:8799", fetcher, now: () => 10_000 });
  const recipient = createCoordinatorNodeClient(bob, { endpoint: "http://127.0.0.1:8799", fetcher, now: () => 10_000 });
  await client.registerSession(signed);
  const sent = await client.send(signed, bob.member.ownerId, { action: "read" }, { sequence: 1, kind: "web.command", now: () => 10_000 });
  assert.equal(sent.accepted, true);
  assert.deepEqual((await recipient.receive(signed, { now: () => 10_000 })).map((item) => item.payload), [{ action: "read" }]);
  await assert.rejects(client.send(signed, bob.member.ownerId, { action: "read again" }, { sequence: 1, kind: "web.command", now: () => 10_000 }), /sequence replay/);
  assert.equal(requests[0].path, "/v1/sessions/session-3/register");
  assert.equal(requests[1].path, "/v1/sessions/session-3/frames");
  assert.equal(JSON.stringify(requests[1].body).includes('"action":"read"'), false);
  assert.equal(requests[2].path, "/v1/sessions/session-3/poll");
});
