import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, createPublicKey } from "node:crypto";

const TEST_RSA_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEArE1xRQWN84rdub+tFgZlszPtd+VlBSZrIla2vkhL0smNkTj0
W2C0ePe42rjP/7Iuk6EnrmJH8r4nAYG5+AsP43wgvT94t+mvrXrG4FViBMHOxftv
2FrDjolLnWDAzYun4fBIwt2BEkpLSleYmmhhq3pdl57NILQ6Z7HWnD4swhUBrECr
zvv2zfjKk7YLhhNF83cKeDK9d5Bv81Pp/rTvJIDuDr4bol07MkJTcIiAAjfh1efV
GGibulmUHorWNBktkhSokn/IX8aJVbfwCt85B59NBcFd1F85oeEuw4dcL+TulVuN
Z0D7Zc39RY1BLHZMy9l0Is0H21bZQqPlwXRBtwIDAQABAoIBACl0mIQaygSGrMI8
M9DQyTdMjx4Bu0R58dzZMC6oBlY42C7QnTo/EizorTkyrhi/LiWm6H00eEsXJRtf
svbS8oexHc9qrgjR2MrMd30SDftHBhDsZgSQEe0Ba4f592l86G+b+GWqFZvo9CR2
3uiHpLg1QL9yHbh4pHS+fPwqmWo4bnlDX8LAB2v0UOy2lc44bbtxVNc6JFNmbIdQ
eKsnrmnXWQYm7a36MpFBq9OHbTQZjmHalB/4cVofVe+KOJDfl4auDdtyxY2uXSBg
+3TG3UZruSI8nEVlBXfAYo58VoZkPo+/0YlApHuSMPJiAUnZMp+8fiM7fj5E/F/p
iCTEMQECgYEA3D2KqI6BcndPI9e9yGqD62bEM2eOFfisT4KeS+zGjP26G3Yy4tdu
Q0n1tRmZL/VgeI8SPkBCE34I2piIgNCiHDizQcZIgMEZWHSd344J2JoWQ5dHW7jE
hqOTl92F2Pgjz+/MeqDyocenj12h2hXbGWCxdcwhYESnp9QaioXCxMcCgYEAyEdT
i2ZobYtVqt+yFZIKzv3417SSivYUUIioHCC7cZU2vEvp2DWzFVW429Hhqb4FvUF+
Vyj+YHMda3tbLAkQUtaglMCEJ4gDY0tgh14Dc7HWdFvPXaScNhkYCkDP8hgElCBT
LR+hYdylQICdSIDPeKGXd8iufPVRHVmoyYgfy5ECgYAi00xoqNgJPJp0BXpKBaXE
hGSD6F0MVl0Q2YukX9Vpl/lkvEUBn6Uc2MYUk+6oKbnOdnkhBNIt+OD3h+UV0WfA
5KpbvTnbui0C0rXgErq12G+q0nIDK+1PiPAetHWkwGARUk7YGTkkoch6IAkmzgvu
MF7/TH7+lPyZyi1EODB7IwKBgC3Ra4J7pi5RbwLNdD9NDt316kTm0ZOq4lDeQp9U
ua0tdr0zHMdS2apq1wSrClY727JFVnL4NOG51CQvr1bup+ZbpZcCR/mHO0cvCmFN
l7qTF7289z60FuylZwOJekknR3zfvEeZceEiikesZM8ecNhnF3DW31xE/w6Y4W1h
j+yRAoGAdj5ukjE5q6CrOX4tvNX7dpcrjlWvIsvlm09JlQQBLc01fELqNMp9SRJ3
OmrbuaAeP8vLJAdO7PWilzr7L0Xz1q+zzqzrYpgkfpu2wTyXcE+0xiFvrMXP7a1N
BifIGxEsHlKi2vEMmdqyLwavLs7niNafNERPXHoxW4zYRcrwCpU=
-----END RSA PRIVATE KEY-----`;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("minting throws without configured GitHub App env vars (fail-closed)", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  await withEnv({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_APP_INSTALLATION_ID: undefined }, async () => {
    await assert.rejects(() => mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }));
  });
});

test("mints a token scoped to exactly one repo, signing a valid RS256 App JWT", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  let capturedAuth: string | null = null;
  let capturedBody: unknown = null;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: "2026-08-04T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;

  try {
    const result = await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: "98765" }, () =>
      mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }));

    assert.equal(result.token, "ghs_faketoken");
    assert.equal(result.expiresAt, "2026-08-04T00:00:00Z");
    assert.equal(capturedUrl, "https://api.github.com/app/installations/98765/access_tokens");
    assert.deepEqual(capturedBody, { repositories: ["widgets"] });

    const authHeader = capturedAuth as string | null;
    if (authHeader === null) throw new Error("expected an Authorization header to have been captured");
    assert.ok(authHeader.startsWith("Bearer "));
    const jwt = authHeader.slice("Bearer ".length);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    assert.equal(header.alg, "RS256");
    assert.equal(payload.iss, "12345");
    assert.ok(payload.exp - payload.iat <= 600, "GitHub App JWTs must not exceed 10 minutes");

    const publicKey = createPublicKey(TEST_RSA_PRIVATE_KEY);
    const valid = verify("RSA-SHA256", Buffer.from(`${headerB64}.${payloadB64}`), publicKey, Buffer.from(sigB64, "base64url"));
    assert.equal(valid, true, "the App JWT signature must verify against the configured private key's public half");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces a clear error when GitHub rejects the token request", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("installation not found", { status: 404 })) as typeof fetch;
  try {
    await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: "bad" }, async () => {
      await assert.rejects(() => mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }), /HTTP 404/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a key pasted with literal \\n escapes and wrapped in quotes (the common env-var-UI mangling) still signs correctly", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  let capturedAuth: string | null = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: "2026-08-04T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;

  const mangledKey = `"${TEST_RSA_PRIVATE_KEY.replace(/\n/g, "\\n")}"`;
  try {
    await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: mangledKey, GITHUB_APP_INSTALLATION_ID: "98765" }, () =>
      mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }));

    const authHeader = capturedAuth as string | null;
    if (authHeader === null) throw new Error("expected an Authorization header to have been captured");
    const jwt = authHeader.slice("Bearer ".length);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const publicKey = createPublicKey(TEST_RSA_PRIVATE_KEY);
    const valid = verify("RSA-SHA256", Buffer.from(`${headerB64}.${payloadB64}`), publicKey, Buffer.from(sigB64, "base64url"));
    assert.equal(valid, true, "a mangled-but-recoverable key must still produce a validly signed JWT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a key stripped to just its base64 body (no BEGIN/END, no newlines) is reconstructed and still signs correctly", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  let capturedAuth: string | null = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: "2026-08-04T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;

  // Exactly what the live diagnostic found: BEGIN/END and all newlines gone,
  // just the base64 body on one line.
  const strippedKey = TEST_RSA_PRIVATE_KEY.replace(/-----BEGIN RSA PRIVATE KEY-----/, "").replace(/-----END RSA PRIVATE KEY-----/, "").replace(/\s+/g, "");
  try {
    await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: strippedKey, GITHUB_APP_INSTALLATION_ID: "98765" }, () =>
      mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }));

    const authHeader = capturedAuth as string | null;
    if (authHeader === null) throw new Error("expected an Authorization header to have been captured");
    const jwt = authHeader.slice("Bearer ".length);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const publicKey = createPublicKey(TEST_RSA_PRIVATE_KEY);
    const valid = verify("RSA-SHA256", Buffer.from(`${headerB64}.${payloadB64}`), publicKey, Buffer.from(sigB64, "base64url"));
    assert.equal(valid, true, "a stripped-to-body key must be reconstructed into a validly signable PEM");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a key missing BEGIN/END markers fails with a clear, actionable message", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: "not-a-real-key", GITHUB_APP_INSTALLATION_ID: "98765" }, async () => {
    await assert.rejects(() => mintRepositoryInstallationToken({ owner: "acme", repo: "widgets" }), /does not look like a PEM private key/);
  });
});

test("an explicit per-workspace installationId is used over the global env var -- the actual cross-tenant boundary", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: "2026-08-04T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;
  try {
    await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: "98765" }, () =>
      mintRepositoryInstallationToken({ owner: "acme", repo: "widgets", installationId: "555000111" }));
    assert.equal(capturedUrl, "https://api.github.com/app/installations/555000111/access_tokens", "must mint against the workspace's own installation, not the global fallback, whenever one is supplied");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the global GITHUB_APP_INSTALLATION_ID when no per-workspace installationId is given (a workspace with no install yet)", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ token: "ghs_faketoken", expires_at: "2026-08-04T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;
  try {
    await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: "98765" }, () =>
      mintRepositoryInstallationToken({ owner: "acme", repo: "widgets", installationId: null }));
    assert.equal(capturedUrl, "https://api.github.com/app/installations/98765/access_tokens");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("still fails closed when neither a per-workspace installationId nor the global fallback is available", async () => {
  const { mintRepositoryInstallationToken } = await import("../src/lib/mission/mission-git-credential-broker.ts");
  await withEnv({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID: undefined }, async () => {
    await assert.rejects(() => mintRepositoryInstallationToken({ owner: "acme", repo: "widgets", installationId: null }), /GITHUB_APP_INSTALLATION_ID is required/);
  });
});
