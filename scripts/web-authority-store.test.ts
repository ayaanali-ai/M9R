import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebAuthority, verifyAudit, type AuditEntry, type WebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";
import { createProtocolLedger, MAX_AWARE_PROTOCOL_FRAMES } from "../packages/web-protocol-placeholder/src/index.ts";

const bob = { owner: "bob", agent: "claude" };
const site = "https://shop.example";

function withStore(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "m9r-web-authority-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function authority(ownerId = "alice"): WebAuthority {
  return createWebAuthority({ ownerId });
}

function granted(auth: WebAuthority): string {
  const request = auth.requestGrant({ grantee: bob, origin: site, actions: ["read", "click"] });
  assert.ok(request.ok);
  const approved = auth.approve(request.request.id);
  assert.ok(approved.ok);
  return approved.grant.id;
}

function legacyAudit(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prev = "genesis";
  for (let seq = 0; seq < count; seq += 1) {
    const base = {
      seq,
      at: 1_700_000_000_000 + seq,
      kind: "action.requested" as const,
      actor: "a",
      action: "click",
      origin: "https://x.io",
      prev,
    };
    const fields = [base.seq, base.at, base.kind, base.actor, "", base.action, base.origin, "", "", base.prev];
    const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    entries.push({ ...base, hash });
    prev = hash;
  }
  return entries;
}

test("authority store round-trips grants, pending requests, and the audit chain", () => {
  withStore((root) => {
    const original = authority();
    const grantId = granted(original);
    const pending = original.requestGrant({ grantee: { owner: "carol", agent: "codex" }, origin: site, actions: ["read"] });
    assert.ok(pending.ok);

    const store = createWebAuthorityStore(root);
    store.save(original.snapshot());
    const restarted = authority();
    restarted.restore(store.load());

    assert.equal(restarted.grants().find((grant) => grant.id === grantId)?.origin, site);
    assert.equal(restarted.pendingRequests()[0]?.id, pending.request.id);
    assert.deepEqual(restarted.audit(), original.audit());
  });
});

test("authority store rejects state growth over its byte budget without replacing valid state", () => {
  withStore((root) => {
    const store = createWebAuthorityStore(root, { maxStateBytes: 128 });
    const base = authority().snapshot();
    store.save(base);
    const path = join(root, "web-authority.json");
    const before = readFileSync(path, "utf8");
    const tooLarge = authority();
    const request = tooLarge.requestGrant({ grantee: bob, origin: site, actions: ["read"] });
    assert.ok(request.ok);
    assert.throws(() => store.save(tooLarge.snapshot()), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), before, "capacity failure preserves the last valid authority file");
  });
});

test("authority store refuses to load an over-budget file before parsing or modifying it", () => {
  withStore((root) => {
    const path = join(root, "web-authority.json");
    const oversized = " ".repeat(129);
    writeFileSync(path, oversized, "utf8");
    const store = createWebAuthorityStore(root, { maxStateBytes: 128 });
    assert.throws(() => store.load(), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), oversized, "the file is left intact for operator recovery");
  });
});

test("authority store preserves browser-action approval events across restart", () => {
  withStore((root) => {
    const original = authority();
    for (const kind of ["action.requested", "action.approved", "action.denied", "action.timed_out"] as const) {
      original.recordActionDecision(kind, "claude", {
        action: "click", ...(kind === "action.requested" ? {} : { origin: site }), selector: "#submit", detail: "outside",
      });
    }
    const store = createWebAuthorityStore(root);
    store.save(original.snapshot());
    assert.deepEqual(store.load().audit.map((entry) => entry.kind), [
      "action.requested", "action.approved", "action.denied", "action.timed_out",
    ]);
  });
});

test("a restart preserves a live grant and its later revocation", () => {
  withStore((root) => {
    const store = createWebAuthorityStore(root);
    const first = authority();
    const grantId = granted(first);
    store.save(first.snapshot());

    const second = authority();
    second.restore(store.load());
    assert.equal(second.check({ grantee: bob, action: "read", origin: site }).allowed, true);
    assert.equal(second.revoke(grantId), true);
    store.save(second.snapshot());

    const third = authority();
    third.restore(store.load());
    assert.equal(third.check({ grantee: bob, action: "read", origin: site }).allowed, false);
    assert.equal(third.grants()[0]?.revokedAt !== undefined, true);
    assert.ok(third.audit().some((entry) => entry.kind === "grant.revoked"));
  });
});

test("a tampered audit chain is quarantined and never restored", () => {
  withStore((root) => {
    const store = createWebAuthorityStore(root);
    const original = authority();
    granted(original);
    store.save(original.snapshot());
    const path = join(root, "web-authority.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { audit: Array<{ actor: string }> };
    persisted.audit[0].actor = "attacker/changed";
    writeFileSync(path, JSON.stringify(persisted));

    const loaded = store.load();
    assert.deepEqual(loaded.audit, []);
    assert.deepEqual(loaded.grants, []);
    assert.ok(readdirSync(root).some((name) => /^web-authority\.json\.corrupt-\d+/.test(name)));
  });
});

test("a malformed authority file is quarantined without crashing", () => {
  withStore((root) => {
    writeFileSync(join(root, "web-authority.json"), "{ definitely not json");
    const loaded = createWebAuthorityStore(root).load();
    assert.deepEqual(loaded, { version: 2, grants: [], requests: [], audit: [], auditAnchor: { sequence: 0, hash: "genesis" } });
    assert.ok(readdirSync(root).some((name) => /^web-authority\.json\.corrupt-\d+/.test(name)));
  });
});

test("oversized audit metadata is compacted with a digest and remains hash-verifiable within the persistence budget", () => {
  withStore((root) => {
    const auth = authority();
    const originalActor = "actor/" + "x".repeat(1024 * 1024);
    const digest = createHash("sha256").update(JSON.stringify(originalActor), "utf8").digest("hex");
    auth.recordActionDecision("action.requested", originalActor, {
      action: "click", origin: site, selector: "#submit", detail: "requested by owner",
    });
    const store = createWebAuthorityStore(root);
    store.save(auth.snapshot());

    const path = join(root, "web-authority.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as ReturnType<WebAuthority["snapshot"]>;
    assert.ok(persisted.audit[0].actor.endsWith(`[truncated sha256:${digest}]`), "the compacted field commits to the full original metadata");
    assert.ok(verifyAudit(persisted.audit, persisted.auditAnchor).ok, "the persisted digest marker must be part of the verified chain");
    assert.ok(Buffer.byteLength(JSON.stringify(persisted.audit), "utf8") <= 512 * 1024);
  });
});

test("a live 20,000-event audit stays within count and byte budgets while preserving its current chain anchor", () => {
  withStore((root) => {
    const auth = authority();
    for (let i = 0; i < 20_000; i += 1) {
      auth.recordActionDecision("action.requested", "alice/claude", {
        action: "click", origin: site, selector: `#button-${i}`, detail: "owner approved the action",
      });
    }
    const snapshot = auth.snapshot();
    assert.ok(snapshot.audit.length <= 2_048);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.audit), "utf8") <= 512 * 1024);
    assert.equal(snapshot.auditAnchor.sequence, snapshot.audit[0]?.seq ?? 20_000);
    assert.equal(snapshot.auditAnchor.hash, snapshot.audit[0]?.prev ?? auth.auditAnchor().hash);
    assert.ok(verifyAudit(snapshot.audit, snapshot.auditAnchor).ok);

    const store = createWebAuthorityStore(root);
    store.save(snapshot);
    assert.ok(statSync(join(root, "web-authority.json")).size < 512 * 1024 + 1024);
  });
});

test("a verified 20,000-entry legacy chain migrates to a bounded audit window with a valid recovery anchor", () => {
  withStore((root) => {
    const audit = legacyAudit(20_000);
    const path = join(root, "web-authority.json");
    const legacy = { version: 1, grants: [], requests: [], audit };
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    const legacyBytes = statSync(path).size;
    assert.ok(legacyBytes > 4_500_000 && legacyBytes < 5_500_000, `fixture should represent the observed 20,000-entry multi-megabyte legacy path (${legacyBytes} bytes)`);

    const migrated = createWebAuthorityStore(root).load();
    const persisted = JSON.parse(readFileSync(path, "utf8")) as ReturnType<WebAuthority["snapshot"]>;
    assert.equal(migrated.version, 2);
    assert.ok(migrated.audit.length <= 2_048);
    assert.ok(Buffer.byteLength(JSON.stringify(migrated.audit), "utf8") <= 512 * 1024);
    assert.equal(migrated.auditAnchor.sequence, migrated.audit[0]?.seq ?? audit.length);
    assert.equal(migrated.auditAnchor.hash, migrated.audit[0]?.prev ?? audit.at(-1)?.hash);
    assert.ok(verifyAudit(migrated.audit, migrated.auditAnchor).ok);
    assert.equal(persisted.version, 2, "successful migration replaces the on-disk legacy format");
    assert.ok(statSync(path).size < legacyBytes, "the migrated file is bounded below the recoverable legacy file size");
  });
});

test("the AWARE protocol journal persists atomically under a strict byte/frame cap and quarantines corruption", () => {
  withStore((root) => {
    const store = createWebAuthorityStore(root);
    const frame = { protocol: "m9r-web/0", message_id: "member-1", message_type: "membership", payload: { member_id: "agent:alice/codex" } };
    store.saveProtocolFrames([frame]);
    assert.deepEqual(createWebAuthorityStore(root).loadProtocolFrames(), [frame]);
    assert.ok(statSync(join(root, "web-aware-ledger.json")).size < 1_048_576);
    assert.throws(() => store.saveProtocolFrames(["x".repeat(1_048_600)]), /over 1 MiB/);

    writeFileSync(join(root, "web-aware-ledger.json"), "{ invalid json", "utf8");
    assert.deepEqual(store.loadProtocolFrames(), []);
    assert.ok(readdirSync(root).some((name) => /^web-aware-ledger\.json\.corrupt-\d+/.test(name)));
  });
});

test("the AWARE journal round-trips exactly one valid terminal stop-all overflow frame", () => {
  withStore((root) => {
    const ordinary = Array.from({ length: MAX_AWARE_PROTOCOL_FRAMES }, (_, index) => ({
      protocol: "m9r-web/0",
      message_id: `ordinary-${index}`,
      session_id: "room-1",
      sender: { principal_id: "agent:codex", key_id: "key-1" },
      sequence: index + 1,
      created_at: "2026-09-28T00:00:00.000Z",
      causal: { lamport: index + 1, observed: [] },
      message_type: "get",
      payload: { resource: "room-state" },
      signature: "dGVzdA",
    }));
    const stop = {
      protocol: "m9r-web/0",
      message_id: "emergency-stop",
      session_id: "room-1",
      sender: { principal_id: "agent:codex", key_id: "key-1" },
      sequence: MAX_AWARE_PROTOCOL_FRAMES + 1,
      created_at: "2026-09-28T00:00:00.000Z",
      causal: { lamport: MAX_AWARE_PROTOCOL_FRAMES + 1, observed: [] },
      message_type: "stop-all",
      payload: { reason: "owner requested stop" },
      signature: "dGVzdA",
    };
    const frames = [...ordinary, stop];
    const store = createWebAuthorityStore(root);
    store.saveProtocolFrames(frames);
    assert.throws(() => store.saveProtocolFrames([...ordinary, { ...stop, payload: { reason: "" } }]), /oversized|terminal stop-all/i);

    const loaded = createWebAuthorityStore(root).loadProtocolFrames();
    assert.deepEqual(loaded, frames);
    assert.equal(loaded.length, MAX_AWARE_PROTOCOL_FRAMES + 1);
    const restarted = createProtocolLedger({ maxFrames: MAX_AWARE_PROTOCOL_FRAMES, now: () => Date.parse("2026-09-28T12:00:00.000Z") });
    restarted.restore(loaded);
    assert.equal(restarted.isStopped(), true, "the persisted emergency stop survives ledger restoration");
    assert.equal(restarted.accept({ ...stop, message_id: "replayed-stop" }, { principalId: "agent:codex" }).ok, false, "the terminal sequence high-water mark survives restoration");
  });
});

test("the AWARE journal reserves bounded byte headroom for an emergency terminal stop-all", () => {
  withStore((root) => {
    const emptyFrames = Array.from({ length: MAX_AWARE_PROTOCOL_FRAMES }, (_, index) => ({
      protocol: "m9r-web/0",
      message_id: `ordinary-${index}`,
      session_id: "room-1",
      sender: { principal_id: "agent:codex", key_id: "key-1" },
      sequence: index + 1,
      created_at: "2026-09-28T00:00:00.000Z",
      causal: { lamport: index + 1, observed: [] },
      message_type: "post",
      payload: { text: "" },
      signature: "dGVzdA",
    }));
    const stop = {
      protocol: "m9r-web/0",
      message_id: "emergency-stop",
      session_id: "room-1",
      sender: { principal_id: "agent:codex", key_id: "key-1" },
      sequence: MAX_AWARE_PROTOCOL_FRAMES + 1,
      created_at: "2026-09-28T00:00:00.000Z",
      causal: { lamport: MAX_AWARE_PROTOCOL_FRAMES + 1, observed: [] },
      message_type: "stop-all",
      payload: { reason: "owner requested stop" },
      signature: "dGVzdA",
    };

    const emptyBytes = Buffer.byteLength(JSON.stringify(emptyFrames), "utf8");
    const terminalBytes = Buffer.byteLength(JSON.stringify([...emptyFrames, stop]), "utf8") - emptyBytes;
    const perFrameText = Math.floor((1_048_576 - emptyBytes - terminalBytes - 1) / MAX_AWARE_PROTOCOL_FRAMES);
    const ordinary = emptyFrames.map((frame) => ({ ...frame, payload: { text: "x".repeat(perFrameText) } }));
    const baseBytes = Buffer.byteLength(JSON.stringify(ordinary), "utf8");
    ordinary[0]!.payload.text += "x".repeat(1_048_576 - 1 - baseBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(ordinary), "utf8"), 1_048_575);

    const frames = [...ordinary, stop];
    const serializedBytes = Buffer.byteLength(JSON.stringify(frames), "utf8");
    assert.ok(serializedBytes > 1_048_576 && serializedBytes <= 1_048_576 + 4_096);
    const store = createWebAuthorityStore(root);
    store.saveProtocolFrames(frames);
    assert.equal(statSync(join(root, "web-aware-ledger.json")).size, serializedBytes);
    assert.deepEqual(store.loadProtocolFrames(), frames);

    ordinary[0]!.payload.text += "x".repeat(4_097);
    assert.throws(() => store.saveProtocolFrames([...ordinary, stop]), /over 1 MiB/);
  });
});

test("the AWARE journal rejects and quarantines oversized forms other than a valid terminal stop-all", () => {
  withStore((root) => {
    const ordinary = Array.from({ length: MAX_AWARE_PROTOCOL_FRAMES }, (_, index) => ({ message_id: `ordinary-${index}` }));
    const regularOverflow = { message_id: "not-a-stop" };
    const store = createWebAuthorityStore(root);
    assert.throws(() => store.saveProtocolFrames([...ordinary, regularOverflow]), /oversized|terminal stop-all/i);
    assert.throws(() => store.saveProtocolFrames([...ordinary, regularOverflow, { message_id: "extra" }]), /oversized/i);

    const path = join(root, "web-aware-ledger.json");
    const malformedStop = {
      protocol: "m9r-web/0",
      message_id: "malformed-stop",
      session_id: "room-1",
      sender: { principal_id: "agent:codex", key_id: "key-1" },
      sequence: 1,
      created_at: "2026-09-28T00:00:00.000Z",
      causal: { lamport: 1, observed: [] },
      message_type: "stop-all",
      payload: { reason: "" },
      signature: "dGVzdA",
    };
    writeFileSync(path, JSON.stringify([...ordinary, malformedStop]), "utf8");
    assert.deepEqual(store.loadProtocolFrames(), []);
    assert.ok(readdirSync(root).some((name) => /^web-aware-ledger\.json\.corrupt-\d+/.test(name)));

    writeFileSync(path, JSON.stringify([...ordinary, regularOverflow]), "utf8");
    assert.deepEqual(store.loadProtocolFrames(), []);
    assert.equal(readdirSync(root).filter((name) => /^web-aware-ledger\.json\.corrupt-\d+/.test(name)).length, 2);
  });
});
