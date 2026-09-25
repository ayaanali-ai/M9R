const ALLOWED_AGENTS = ["claude", "codex", "opencode", "other"];
const OWNER = "tysonali989@gmail.com";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/waitlist") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
    let email = "";
    let agents = "";
    try {
      const ct = request.headers.get("content-type") || "";
      const body = ct.includes("json") ? await request.json() : Object.fromEntries(await request.formData());
      email = String(body.email || "").trim().toLowerCase();
      const raw = Array.isArray(body.agents) ? body.agents : String(body.agents || "").split(",");
      agents = raw.map((a) => String(a).trim().toLowerCase()).filter((a) => ALLOWED_AGENTS.includes(a)).join(",");
    } catch { /* fall through to validation */ }
    if (!EMAIL_RE.test(email) || email.length > 254) return json({ ok: false, error: "Enter a valid email address." }, 400);
    const now = new Date().toISOString();
    const res = await env.DB.prepare("INSERT OR IGNORE INTO waitlist (email, created_at, source, agents) VALUES (?, ?, ?, ?)")
      .bind(email, now, "homepage", agents).run();
    const added = (res.meta?.changes ?? 0) > 0;
    if (added && env.EMAIL) {
      ctx.waitUntil((async () => {
        try {
          const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first();
          await env.EMAIL.send({
            from: "M9R <hello@m9r.dev>",
            to: OWNER,
            subject: "New M9R waitlist signup (" + (total?.n ?? "?") + " total)",
            text: [email, "Agents: " + (agents || "not given"), "Time: " + now].join(String.fromCharCode(10)),
          });
        } catch (e) { console.log("owner notification failed", String(e)); }
        try {
          await env.EMAIL.send({
            from: "M9R <hello@m9r.dev>",
            to: email,
            subject: "You're on the M9R list",
            text: "Thanks for joining the M9R waitlist. M9R puts AI agents on the same web page, aware of each other and answering to their owners. We'll write when there's something to try beyond the sandbox: https://m9r.dev/try/\n\nIf this wasn't you, ignore this email and you won't hear from us again.",
          });
          await env.DB.prepare("UPDATE waitlist SET confirmed = 1 WHERE email = ?").bind(email).run();
        } catch (e) { console.log("confirmation email failed", String(e)); }
      })());
    }
    return json({ ok: true, added }, 200);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
