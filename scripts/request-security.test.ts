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
  }), true);
});

test("API guard permits same-origin and server-to-server writes", () => {
  const allowedOrigins = new Set(["https://oathlock.vercel.app"]);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: "https://oathlock.vercel.app",
    fetchSite: "same-origin",
    allowedOrigins,
  }), false);
  assert.equal(isCrossSiteWrite({
    method: "POST",
    origin: null,
    fetchSite: null,
    allowedOrigins,
  }), false);
});
