import assert from "node:assert/strict";
import test from "node:test";
import { apiBodyLimit, evaluateContentLength, isCrossSiteWrite, evaluateBodySize } from "@/lib/request-security-core";

test("body limits count actual bytes without trusting Content-Length and preserve the original body", async () => {
  const request = new Request("https://example.test/api/test", { method: "POST", body: "éé" });
  assert.equal(await evaluateBodySize(request, 3), "too_large");
  const accepted = new Request("https://example.test", { method: "POST", body: "abcd" });
  assert.equal(await evaluateBodySize(accepted, 4), "ok");
  assert.equal(await accepted.text(), "abcd");
});

test("streamed bodies stop at the byte budget and cancel the producer", async () => {
  let chunks = 0;
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  const request = new Request("https://example.test/api/test", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal(await evaluateBodySize(request, 2048), "too_large");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(chunks <= 6, `read ${chunks} chunks beyond limit`);
  assert.equal(cancelled, true);
});

test("a stalled upload has a total deadline", async () => {
  const request = new Request("https://example.test/api/test", { method: "POST", body: new ReadableStream({}) , duplex: "half" } as RequestInit);
  assert.equal(await evaluateBodySize(request, 2048, 10), "timed_out");
});

test("attachment upload allowance stays bounded and other routes retain their default", () => {
  assert.equal(apiBodyLimit("/api/dashboard/conversations/room/attachments", 4 * 1024 * 1024), 26 * 1024 * 1024);
  assert.equal(apiBodyLimit("/api/traces/upload", 4 * 1024 * 1024), 4 * 1024 * 1024);
  assert.equal(apiBodyLimit("/api/messages", Number.MAX_SAFE_INTEGER), 32 * 1024 * 1024);
});

test("API guard classifies malformed and oversized body lengths", () => {
  assert.equal(evaluateContentLength(null, 100), "ok");
  assert.equal(evaluateContentLength("100", 100), "ok");
  assert.equal(evaluateContentLength("101", 100), "too_large");
  assert.equal(evaluateContentLength("not-a-number", 100), "invalid");
});

test("API guard rejects cross-site writes", () => {
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: "https://attacker.example",
    fetchSite: "cross-site",
    allowedOrigins: new Set(["https://oathlock.vercel.app"]),
    hasBearerAuthorization: false,
  }), true);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: null,
    fetchSite: "cross-site",
    allowedOrigins: new Set(["https://oathlock.vercel.app"]),
    hasBearerAuthorization: true,
  }), true, "an explicit cross-site Sec-Fetch-Site must reject even with a bearer token present");
});

test("API guard permits same-origin and server-to-server writes", () => {
  const allowedOrigins = new Set(["https://oathlock.vercel.app"]);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: "https://oathlock.vercel.app",
    fetchSite: "same-origin",
    allowedOrigins,
    hasBearerAuthorization: false,
  }), false);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: null,
    fetchSite: null,
    allowedOrigins,
    hasBearerAuthorization: true,
  }), false, "bearer-authenticated server-to-server calls have no Origin/Sec-Fetch-Site and must still pass");
});

test("API guard fails closed when Origin, Sec-Fetch-Site, and bearer auth are all absent", () => {
  const allowedOrigins = new Set(["https://oathlock.vercel.app"]);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: null,
    fetchSite: null,
    allowedOrigins,
    hasBearerAuthorization: false,
  }), true, "a state-changing request with none of Origin, Sec-Fetch-Site, or a bearer token must be rejected");
});

test("API guard admits a cookieless, tokenless non-browser write (nothing to forge) but not one carrying cookies", () => {
  const allowedOrigins = new Set(["https://oathlock.vercel.app"]);
  const base = { method: "POST", origin: null, fetchSite: null, allowedOrigins, hasBearerAuthorization: false };
  assert.equal(isCrossSiteWrite({ ...base, hasCookies: false }), false, "CLI /api/agent/register sends no cookie, no Origin and no bearer");
  assert.equal(isCrossSiteWrite({ ...base, hasCookies: true }), true, "ambient cookies with no Origin/Sec-Fetch-Site must still fail closed");
});
