import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Use an existing Playwright installation; this script never installs packages.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.DASHBOARD_TEST_URL || "http://127.0.0.1:3010";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local fixtures must never run against production");
const output = process.env.DASHBOARD_TEST_OUTPUT || "artifacts/dashboard-renovation";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const timestamp = "2026-09-08T15:00:00.000Z";
function message(id, body) {
  return { id, body, sender_user_id: "preview-user", sender_connection_id: null, sender_display_name: "Local test", recipient_connection_id: null, kind: "message", created_at: timestamp, spawned_run_id: null, parent_message_id: null, edited_at: null, deleted_at: null, attachments: [], reactions: [], todos: [] };
}
const conversation = { id: "fixture-channel", topic: "general", channel_slug: "general", channel_kind: "channel", status: "open", created_at: timestamp, participant_connection_ids: [], description: "Local component test", is_private: false, unread_count: 0, messages: [], mission_id: null, agent_replies_paused_at: null };
let failNext = false;
const sends = [];
await page.route("**/api/**", async route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  let response = {};
  if (pathname === "/api/dashboard/conversations") response = { conversations: [conversation] };
  if (pathname.endsWith("/members")) response = { members: [] };
  if (pathname.endsWith("/pending-decisions")) response = { evidenceRequests: [], runStartApprovals: [], findings: [], ruleDrafts: [], permissions: [], evidenceSubmissions: [] };
  if (pathname.endsWith("/notifications")) response = { notifications: [] };
  if (pathname.endsWith("/messages") && request.method() === "POST") {
    const data = request.postDataJSON();
    sends.push({ ...data, header: request.headers()["idempotency-key"] });
    if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { error: "Fixture: delivery unavailable" } }); return; }
    const posted = message(`fixture-${sends.length}`, data.body);
    conversation.messages.push(posted);
    response = { message: posted };
  }
  await route.fulfill({ status: 200, json: response });
});
// No real API call can escape the fixture intercept, including writes.
await page.addInitScript(() => localStorage.setItem("oathlock_sidebar_collapsed", "0"));
try {
  await page.goto(`${base}/design/dashboard/runtime?conversation=fixture-channel`);
  const composer = page.getByRole("textbox", { name: "Message #general", exact: true });
  await composer.waitFor();
  await page.locator(".m9r-etheral-shadow").waitFor();
  await page.locator(".m9r-workspace-welcome").waitFor();
  assert.equal(await page.locator(".m9r-etheral-shadow").getAttribute("aria-hidden"), "true");
  await page.screenshot({ path: path.join(output, "actual-shell-empty-desktop.png") });
  const metrics = await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector(".wf-chat-composer textarea"));
    const b = getComputedStyle(document.querySelector(".wf-chat-mention-highlight-backdrop"));
    return [a.fontSize === b.fontSize, a.lineHeight === b.lineHeight, document.documentElement.scrollWidth <= innerWidth];
  });
  assert.deepEqual(metrics, [true, true, true], "Mention backdrop and page geometry");
  await composer.fill("@");
  const mentionMenu = page.locator(".wf-chat-mention-menu");
  await mentionMenu.waitFor();
  const mentionMenuGeometry = await mentionMenu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const field = element.parentElement?.getBoundingClientRect();
    return { width: rect.width, fieldWidth: field?.width ?? 0, rows: element.querySelectorAll("button").length };
  });
  assert.ok(mentionMenuGeometry.rows > 0, "Mention menu renders connected agents");
  assert.ok(mentionMenuGeometry.width < mentionMenuGeometry.fieldWidth, "Mention menu stays compact instead of spanning the composer");
  await composer.fill("");
  console.log("PASS actual shell, decorative art, mention metrics, desktop overflow");

  const initialHeight = (await composer.boundingBox()).height;
  await composer.fill(Array(12).fill("Multiline sizing fixture").join("\n"));
  await page.waitForFunction(height => document.querySelector(".wf-chat-composer textarea").getBoundingClientRect().height > height, initialHeight);
  assert.equal(await composer.evaluate(el => getComputedStyle(el).resize), "none");
  await composer.fill("Local transport fixture — no external delivery.");
  await composer.press("Shift+Enter");
  assert.equal(sends.length, 0, "Shift Enter inserts a newline without submitting");
  await composer.press("Enter");
  await page.locator("#message-fixture-1").waitFor();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].header, sends[0].idempotencyKey);
  assert.equal(await composer.inputValue(), "");
  console.log("PASS actual HTTP send handler, confirmation, idempotency, draft clearing");
  await page.waitForFunction(() => localStorage.getItem("m9r:channel-started:workspace:preview-user:fixture-channel") === "1");
  const storedMessages = conversation.messages;
  conversation.messages = [];
  await page.reload();
  await composer.waitFor();
  assert.equal(await page.locator(".m9r-workspace-welcome").count(), 0, "Welcome stays dismissed after empty history and reload");
  conversation.messages = storedMessages;
  console.log("PASS auto-grow, Shift Enter, Enter send, durable welcome dismissal");

  failNext = true;
  await composer.fill("Retry fixture");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Fixture: delivery unavailable", { exact: true }).waitFor();
  await page.getByRole("button", { name: /retry/i }).first().click();
  await page.locator("#message-fixture-3").waitFor();
  assert.equal(sends[1].idempotencyKey, sends[2].idempotencyKey);
  console.log("PASS visible send failure and retry using the same idempotency key");

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width < 768) {
      await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
      await page.mouse.move(380, 400);
      const sendBox = await page.getByRole("button", { name: "Send message", exact: true }).boundingBox();
      const navBox = await page.locator(".product-mobile-nav").boundingBox();
      assert.ok(sendBox && navBox && sendBox.y + sendBox.height <= navBox.y, "Send control clears mobile navigation");
    }
    const box = await composer.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, "Composer remains in viewport");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page horizontal overflow");
    await page.screenshot({ path: path.join(output, `actual-shell-messages-${viewport.width}.png`) });
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("PASS actual mobile/desktop composer visibility and zero browser runtime errors");

  await page.goto(`${base}/design/dashboard`);
  await page.getByRole("button", { name: "Sample conversation", exact: true }).click();
  await page.getByRole("button", { name: "Toggle preview theme" }).click();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await page.getByRole("complementary", { name: "People preview" }).waitFor();
  await page.screenshot({ path: path.join(output, "design-bench-night-panel.png") });
  console.log("PASS visual fixture conversation, night mode and panel controls (not provider connectivity)");
} catch (error) {
  console.error("Test failure:", error);
  console.error("Browser errors:", errors);
  console.error("Visible headings:", await page.getByRole("heading").allTextContents().catch(() => []));
  await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
