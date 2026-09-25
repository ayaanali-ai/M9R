import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebAuthority, type WebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";

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
    assert.deepEqual(loaded, { version: 1, grants: [], requests: [], audit: [] });
    assert.ok(readdirSync(root).some((name) => /^web-authority\.json\.corrupt-\d+/.test(name)));
  });
});
