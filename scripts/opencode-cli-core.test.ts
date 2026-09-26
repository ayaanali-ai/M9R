import assert from "node:assert/strict";
import test from "node:test";
import { runOpenCodeCli } from "@/lib/native/opencode-cli-core";

function fakeServer() {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
    if (url.endsWith("/session") && method === "GET") {
      return new Response(JSON.stringify([{ id: "oc-1", directory: "C:/Work/Project", title: "M9R integration" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/session/oc-1/prompt_async") && method === "POST") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

test("OpenCode CLI lists sessions with project folders and sends only to an explicit attached session", async () => {
  const fake = fakeServer();
  const out: string[] = [];
  const err: string[] = [];
  const io = { baseUrl: "http://127.0.0.1:4096", fetch: fake.fetcher, out: (line: string) => out.push(line), err: (line: string) => err.push(line) };

  assert.equal(await runOpenCodeCli(["sessions"], io), 0);
  assert.match(out.join("\n"), /oc-1\tc:\/work\/project\tM9R integration/);
  assert.equal(await runOpenCodeCli(["send", "--folder", "C:/Work/Project", "--session", "oc-1", "--text", "continue"], io), 0);
  assert.deepEqual(fake.calls.map(({ method, url }) => [method, url]), [
    ["GET", "http://127.0.0.1:4096/session"],
    ["GET", "http://127.0.0.1:4096/session"],
    ["POST", "http://127.0.0.1:4096/session/oc-1/prompt_async"],
  ]);
  assert.deepEqual(JSON.parse(fake.calls[2].body ?? "{}"), { parts: [{ type: "text", text: "continue" }] });
  assert.match(out.at(-1) ?? "", /Message sent to OpenCode session oc-1/);
  assert.deepEqual(err, []);
});

test("OpenCode send refuses an unqualified session instead of guessing", async () => {
  const fake = fakeServer();
  const err: string[] = [];
  const code = await runOpenCodeCli(["send", "--session", "oc-1", "--text", "continue"], {
    baseUrl: "http://127.0.0.1:4096", fetch: fake.fetcher, out: () => {}, err: (line) => err.push(line),
  });
  assert.equal(code, 2);
  assert.match(err.join("\n"), /--folder <absolute-path>/);
  assert.equal(fake.calls.length, 0);
});
