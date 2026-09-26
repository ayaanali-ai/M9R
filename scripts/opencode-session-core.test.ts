import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCodeSessionAdapter } from "@/lib/native/opencode-session-core";

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch");
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

test("OpenCode adapter attaches to the exact session in the requested normalized folder", async () => {
  const fake = fakeFetch([{ body: [
    { id: "oc-one", directory: "C:\\Work\\Project", title: "one" },
    { id: "oc-other", directory: "C:\\Work\\Other", title: "other" },
  ] }]);
  const adapter = createOpenCodeSessionAdapter({ baseUrl: "http://127.0.0.1:4096", fetch: fake.fetcher });
  const attached = await adapter.attach({ projectFolder: "c:/work/project/", sessionId: "oc-one" });
  assert.deepEqual(attached, { provider: "opencode", sessionId: "oc-one", projectFolder: "c:/work/project", title: "one" });
  assert.equal(fake.calls[0].url, "http://127.0.0.1:4096/session");
});

test("OpenCode attach never guesses when a folder has multiple sessions and rejects cross-folder IDs", async () => {
  const sessions = [
    { id: "oc-one", directory: "C:\\Work\\Project" },
    { id: "oc-two", directory: "c:/work/project" },
  ];
  const ambiguous = createOpenCodeSessionAdapter({ baseUrl: "http://localhost:4096", fetch: fakeFetch([{ body: sessions }]).fetcher });
  await assert.rejects(ambiguous.attach({ projectFolder: "C:\\Work\\Project" }), /ambiguous.*2/i);

  const wrongFolder = createOpenCodeSessionAdapter({ baseUrl: "http://localhost:4096", fetch: fakeFetch([{ body: sessions }]).fetcher });
  await assert.rejects(wrongFolder.attach({ projectFolder: "C:\\Work\\Elsewhere", sessionId: "oc-one" }), /not in the requested folder/i);
});

test("OpenCode prompts are sent only to an explicitly selected session via prompt_async", async () => {
  const fake = fakeFetch([
    { body: [{ id: "session / one", directory: "C:\\Work\\Project" }] },
    { status: 204, body: null },
  ]);
  const adapter = createOpenCodeSessionAdapter({ baseUrl: "http://localhost:4096", fetch: fake.fetcher, username: "opencode", password: "local-secret" });
  const session = await adapter.attach({ projectFolder: "C:/Work/Project", sessionId: "session / one" });
  await adapter.send({ session, text: "Review the diff" });
  assert.equal(fake.calls[1].url, "http://localhost:4096/session/session%20%2F%20one/prompt_async");
  assert.equal(fake.calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(fake.calls[1].init?.body)), { parts: [{ type: "text", text: "Review the diff" }] });
  assert.equal(new Headers(fake.calls[1].init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:local-secret").toString("base64")}`);
  await assert.rejects(adapter.send({ session: { ...session, sessionId: "not-attached" }, text: "No" }), /was not attached/i);
});

test("OpenCode connection is restricted to local servers and does not expose response bodies on HTTP errors", async () => {
  assert.throws(() => createOpenCodeSessionAdapter({ baseUrl: "https://example.com" }), /loopback/i);
  assert.throws(() => createOpenCodeSessionAdapter({ baseUrl: "http://user:pass@localhost:4096" }), /credentials/i);
  const adapter = createOpenCodeSessionAdapter({ baseUrl: "http://localhost:4096", fetch: fakeFetch([{ status: 401, body: { error: "password=hidden-secret" } }]).fetcher });
  await assert.rejects(adapter.health(), (error: unknown) => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes("hidden-secret"));
});
