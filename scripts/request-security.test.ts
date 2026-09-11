import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContentLength, isCrossSiteWrite } from "@/lib/request-security-core";

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
