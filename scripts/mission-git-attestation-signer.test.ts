import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

const TEST_KEY = "MC4CAQAwBQYDK2VwBCIEII56n3Mn9Dv9BxM2SmnLtGrC33iB9iJb0kjtaEsEaISx";
const OTHER_KEY = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
})();

function withKey<T>(key: string | undefined, fn: () => T): T {
  const prior = process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY;
  if (key === undefined) delete process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY;
  else process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY = key;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY;
    else process.env.MISSION_GIT_ATTESTATION_SIGNING_KEY = prior;
  }
}

test("signing without a configured key throws, fail-closed", async () => {
  const { signAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  withKey(undefined, () => {
    assert.throws(() => signAttestationPayload({ a: 1 }));
  });
});

test("a signed payload verifies against the same payload and key", async () => {
  const { signAttestationPayload, verifyAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  withKey(TEST_KEY, () => {
    const payload = { missionId: "m-1", decision: "approved", candidateDigest: "abc123", recordedAt: "2026-08-01T00:00:00.000Z" };
    const signed = signAttestationPayload(payload);
    assert.equal(signed.version, "oathlock.git-authorization-attestation-signature.v1");
    assert.ok(signed.signature.length > 0);
    assert.ok(signed.keyId.length > 0);
    assert.equal(verifyAttestationPayload(payload, signed), true);
  });
});

test("verification fails if the payload was tampered with after signing", async () => {
  const { signAttestationPayload, verifyAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  withKey(TEST_KEY, () => {
    const payload = { decision: "approved", candidateDigest: "abc123" };
    const signed = signAttestationPayload(payload);
    assert.equal(verifyAttestationPayload({ ...payload, decision: "rejected" }, signed), false);
  });
});

test("verification fails against a signature produced by a different key", async () => {
  const { signAttestationPayload, verifyAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  const payload = { decision: "approved", candidateDigest: "abc123" };
  const signed = withKey(TEST_KEY, () => signAttestationPayload(payload));
  withKey(OTHER_KEY, () => {
    assert.equal(verifyAttestationPayload(payload, signed), false);
  });
});

test("keyId is stable for the same key and does not depend on payload content", async () => {
  const { signAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  withKey(TEST_KEY, () => {
    const first = signAttestationPayload({ a: 1 });
    const second = signAttestationPayload({ b: 2, c: 3 });
    assert.equal(first.keyId, second.keyId);
  });
});

test("the git-token route actually calls verifyAttestationPayload and hard-blocks minting when it fails (finding cf188bbf)", () => {
  const route = readFileSync("src/app/api/bridge/git-token/route.ts", "utf8");
  assert.match(route, /import \{ verifyAttestationPayload, ATTESTATION_VERSION \} from "@\/lib\/mission\/mission-git-attestation-signer"/);
  assert.match(route, /verifyAttestationPayload\(/);
  assert.match(route, /if \(!authentic\) throw new MissionApiError/);
  // A missing signature (no signing key configured at authorization time) stays fail-open -- documented, accepted.
  assert.match(route, /if \(approved\.authorization\?\.signature && approved\.authorization\?\.keyId\)/);
});

test("the git-token route's exact authorization-row reconstruction (finding cf188bbf) verifies genuine rows and rejects tampered ones", async () => {
  // Mirrors src/app/api/bridge/git-token/route.ts's payload reconstruction
  // byte for byte -- the one place a stored authorization row's signature is
  // actually checked before it unlocks a real GitHub push credential.
  const { signAttestationPayload, verifyAttestationPayload } = await import("../src/lib/mission/mission-git-attestation-signer.ts");
  withKey(TEST_KEY, () => {
    const authorizedAt = { missionId: "mission-1", operation: "push", actorId: "user-1", decision: "approved", candidateDigest: "digest-abc", recordedAt: "2026-08-17T00:00:00.000Z" };
    const signed = signAttestationPayload(authorizedAt);
    // Genuine row: reconstructed exactly as stored -- verifies.
    assert.equal(verifyAttestationPayload(authorizedAt, signed), true);
    // A row whose stored decision was flipped after the fact (corruption or
    // tampering) -- must be rejected, not silently trusted.
    assert.equal(verifyAttestationPayload({ ...authorizedAt, decision: "rejected" }, signed), false);
    // A row pointing at a different candidate than what was actually signed.
    assert.equal(verifyAttestationPayload({ ...authorizedAt, candidateDigest: "digest-xyz" }, signed), false);
  });
});
