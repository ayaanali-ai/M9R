// Message view: one line, your connected providers' logos inside it. Tap logos to choose who gets the message; with none
// chosen it goes to whoever is centred on the drum. Replies from agents appear above.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { createDictation, type Dictation } from "../core/speech";
import { State, type AgentTask, type ChatMessage, type DroppedFile, type LinkOffer } from "../core/state";
import type { SessionRow } from "../core/transport";
import type { ViewActions, ViewHost } from "./views";
import { providerLogo } from "./provider";
import { displayName } from "../core/humanize";
import { botGlowColor } from "../core/layout";

let nextId = 1;

/** Temporary diagnostic bridge for the dictation investigation; logs to the Rust process's stderr
 * when M9R_DEBUG=1, since this webview's own DevTools console has been unreliable to read live. */
function debugLog(msg: string): void {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
  if (invoke) void invoke("log_debug", { msg }).catch(() => {});
}

const hhmm = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** "Link a session…" under an undelivered message: pick which of the target agent's sessions this one should always reach. */
function linkPicker(offer: LinkOffer, linking: NonNullable<ViewActions["linking"]>, onHeightChange: () => void): HTMLElement {
  const toggle = h("button", { class: "chip settled", type: "button", text: "Link a session…" });
  const list = h("div", { class: "picker" });
  list.hidden = true;
  const wrap = h("div", { class: "link-offer" }, toggle, list);
  toggle.addEventListener("click", async () => {
    if (!list.hidden) { list.hidden = true; onHeightChange(); return; }
    clear(list);
    list.append(h("div", { class: "reply", text: "Loading…" }));
    list.hidden = false;
    onHeightChange();
    let rows: SessionRow[] = [];
    try { rows = await linking.list(offer.to); } catch { /* shown as "none seen" below */ }
    clear(list);
    if (rows.length === 0) list.append(h("div", { class: "reply", text: `No @${offer.to} sessions seen yet.` }));
    for (const row of rows.slice(0, 6)) {
      const item = h("button", { class: "chip settled picker-item", type: "button", text: `${row.cwd ?? "(no folder)"} · ${hhmm(row.lastSeenAt)}` });
      item.addEventListener("click", async () => {
        clear(wrap);
        try {
          await linking.link(offer, row.sessionId);
          wrap.append(h("div", { class: "reply", text: `Linked. Send it again and it will go to that @${offer.to} session.` }));
        } catch (err) {
          wrap.append(h("div", { class: "reply", text: `Couldn't link: ${String(err instanceof Error ? err.message : err).slice(0, 100)}` }));
        }
        onHeightChange();
      });
      list.append(item);
    }
    onHeightChange();
  });
  return wrap;
}

/** The leading "@codex @claude " routing prefix of a sent message, split from what the owner actually wrote. */
function splitRecipients(text: string): { to: AgentTask[]; body: string } {
  const lead = /^(?:@[A-Za-z0-9-]+\s+)+/.exec(text)?.[0] ?? "";
  const to = [...lead.matchAll(/@([A-Za-z0-9-]+)/g)]
    .map((m) => State.tasks.find((t) => t.name.toLowerCase() === m[1].toLowerCase()))
    .filter((t): t is AgentTask => !!t);
  return to.length ? { to, body: text.slice(lead.length) } : { to: [], body: text };
}

function bubble(message: ChatMessage, actions: ViewActions, onHeightChange: () => void): HTMLElement {
  if (message.role === "user") {
    const { to, body } = splitRecipients(message.content);
    const who = to.length
      ? h("span", { class: "sent-to", title: `To ${to.map(displayName).join(", ")}` }, ...to.map((t) => providerLogo(t.provider, 11)))
      : null;
    // Attached paths travel in the text for the agent; the owner sees file chips, not a list of paths.
    const cut = body.indexOf(ATTACHED);
    const said = cut < 0 ? body : body.slice(0, cut);
    const files = cut < 0 ? [] : body.slice(cut + ATTACHED.length).split("\n").filter(Boolean);
    const bubbleEl = h("div", { class: "bubble", text: said });
    if (files.length) {
      bubbleEl.append(h("span", { class: "bubble-files" }, ...files.map((f) => h("span", { class: "file-chip sent", title: f },
        svg(ICONS.doc, 11), h("span", { text: f.split(/[\\/]/).pop() ?? f })))));
    }
    return h("div", { class: "chat-row user" }, who, bubbleEl);
  }
  // Replies arrive as "codex: text"; the handle becomes the provider's logo, never raw text in the bubble.
  const from = /^([A-Za-z0-9-]+):\s/.exec(message.content);
  const sender = from ? State.tasks.find((t) => t.name.toLowerCase() === from[1].toLowerCase()) : undefined;
  const reply = h("div", { class: "bubble", text: sender ? message.content.slice(from![0].length) : message.content });
  if (sender) {
    reply.prepend(h("span", { class: "reply-from", title: displayName(sender) }, providerLogo(sender.provider, 11)));
  }
  const clearNotice = message.dismissTaskId && actions.dismissTask
    ? h("button", { class: "save-note", type: "button", text: "Clear notice", title: "Hide this notice; keep its task record" })
    : null;
  clearNotice?.addEventListener("click", () => {
    clearNotice.setAttribute("disabled", "true");
    void actions.dismissTask!(message.dismissTaskId!).then(
      () => { State.dismissChatMessage(message.id); onHeightChange(); },
      () => { clearNotice.removeAttribute("disabled"); clearNotice.textContent = "Couldn't clear"; },
    );
  });
  if (actions.saveMemory && message.content.trim().length >= 8 && !message.link) {
    const save = h("button", { class: "save-note", type: "button", text: "Save to memory", title: "Share this with your team's agents" });
    save.addEventListener("click", () => {
      save.setAttribute("disabled", "true");
      save.textContent = "Saving…";
      actions.saveMemory!(message.content).then(
        () => { save.textContent = "Saved"; },
        () => { save.textContent = "Couldn't save"; save.removeAttribute("disabled"); },
      );
    });
    return h("div", { class: "chat-row reply-row" }, reply, save, clearNotice);
  }
  if (message.link && actions.linking) return h("div", { class: "chat-row link-row" }, reply, linkPicker(message.link, actions.linking, onHeightChange), clearNotice);
  return h("div", { class: "chat-row" }, reply, clearNotice);
}

/** One line by default; grows with the draft, but a pasted document never consumes the island. */
export function cappedDraftHeight(scrollHeight: number): number {
  return Math.max(20, Math.min(120, Number.isFinite(scrollHeight) ? scrollHeight : 20));
}

/** The @handle being typed at the caret, if any. Kept as a pure helper for the composer and its state tests. */
export function mentionAt(text: string, caret: number): { start: number; partial: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([A-Za-z0-9-]{0,38})$/.exec(before);
  return match
    ? { start: before.length - match[2].length - 1, partial: match[2].toLowerCase() }
    : null;
}

const ATTACHED = "\n\nAttached:\n";

/** One-tap starts for a dropped file. Anything that leaves your machine asks to be shown first. */
const FILE_ASKS = [
  { label: "Summarize it", text: "Summarize this." },
  { label: "Email it", text: "Draft an email with this attached. Show me the email before you send it." },
  { label: "Fill it out and submit", text: "Fill this out and submit it. Show me before you submit." },
];

function fileWord(files: DroppedFile[]): string {
  return files.length === 1 ? files[0].name : `these ${files.length} files`;
}

/** "Message Claude Code…", "Message Codex and Claude Code…", "Message 4 agents…". */
function placeholderFor(to: AgentTask[], files: DroppedFile[] = []): string {
  const names = to.map(displayName);
  if (files.length) {
    const who = names.length === 1 ? names[0] : names.length === 0 ? "your agents" : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} agents`;
    return `What should ${who} do with ${fileWord(files)}?`;
  }
  if (names.length === 0) return "Message your agents…";
  if (names.length > 3) return `Message ${names.length} agents…`;
  if (names.length === 1) return `Message ${names[0]}…`;
  if (names.length === 2) return `Message ${names[0]} and ${names[1]}…`;
  return `Message ${names[0]}, ${names[1]}, and ${names[2]}…`;
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const log = h("div", { class: "chat-log", role: "log", "aria-label": "Conversation" });
  const input = h("textarea", {
    class: "chat-input",
    rows: 1,
    placeholder: "Message your agents…",
    "aria-label": "Message your agents",
    spellcheck: "false",
    autocomplete: "off",
  });
  // Who gets the message. Empty means "whoever is centred on the drum", shown as that logo softly lit.
  const armed = new Set<string>();
  const agents = h("div", { class: "ag-group", role: "group", "aria-label": "Send to" });
  let agentKey = "";

  function recipients(): AgentTask[] {
    const chosen = State.tasks.filter((t) => armed.has(t.id));
    if (chosen.length) return chosen;
    return State.focusTask ? [State.focusTask] : [];
  }

  // Dropped files wait here as chips, with a few one-tap starts while the field is still empty.
  const tray = h("div", { class: "composer-tray" });
  const asks = h("div", { class: "composer-asks" });
  let trayKey = "";
  tray.hidden = true;
  asks.hidden = true;

  function syncFiles() {
    const files = State.pendingFiles;
    const key = `${files.map((f) => f.path ?? f.name).join("|")}#${input.value.trim() ? 1 : 0}`;
    if (key === trayKey) return;
    trayKey = key;
    tray.replaceChildren(...files.map((file, i) => {
      const remove = h("button", { class: "file-x", type: "button", title: "Remove", "aria-label": `Remove ${file.name}` }, svg(ICONS.xmark, 9));
      remove.addEventListener("mousedown", (e) => e.preventDefault());
      remove.addEventListener("click", () => {
        State.pendingFiles = State.pendingFiles.filter((_, j) => j !== i);
        syncFiles();
        syncAgents();
        resizeDraft();
        onHeightChange();
      });
      return h("span", { class: "file-chip", title: file.path ?? file.name }, svg(ICONS.doc, 12), h("span", { class: "file-name", text: file.name }), remove);
    }));
    asks.replaceChildren(...(files.length && !input.value.trim() ? FILE_ASKS : []).map((ask) => {
      const b = h("button", { class: "ask-chip", type: "button", text: ask.label });
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        input.value = ask.text;
        resizeDraft();
        syncFiles();
        input.focus();
      });
      return b;
    }));
    tray.hidden = files.length === 0;
    asks.hidden = asks.childElementCount === 0;
    onHeightChange();
  }

  function syncAgents() {
    if (State.composeTo) {
      armed.clear();
      for (const id of State.composeTo) if (State.tasks.some((t) => t.id === id)) armed.add(id);
      State.composeTo = null;
      agentKey = "";
    }
    for (const id of armed) if (!State.tasks.some((t) => t.id === id)) armed.delete(id);
    const focus = State.focusTask?.id;
    const key = `${State.tasks.map((t) => `${t.id}:${t.state}`).join("|")}#${[...armed].join(",")}#${focus}`;
    if (key !== agentKey) {
      agentKey = key;
      agents.replaceChildren(...State.tasks.map((task) => {
        const on = armed.has(task.id);
        const implied = armed.size === 0 && task.id === focus;
        const b = h("button", {
          class: "ag" + (on ? " on" : implied ? " implied" : ""),
          type: "button",
          title: on ? `${displayName(task)} · tap to remove` : implied ? `${displayName(task)} · gets this unless you pick others` : `Send to ${displayName(task)} too`,
          "aria-label": displayName(task),
          "aria-pressed": String(on || implied),
        }, providerLogo(task.provider, 13));
        b.style.setProperty("--tone", botGlowColor(task.state === "idle" || task.state === "sleeping" ? "working" : task.state));
        b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the field
        b.addEventListener("click", () => {
          if (armed.has(task.id)) armed.delete(task.id);
          else armed.add(task.id);
          actions.blip();
          syncAgents();
        });
        return b;
      }));
      agents.hidden = State.tasks.length === 0;
    }
    input.placeholder = placeholderFor(recipients(), State.pendingFiles);
  }
  // The invisible twin measures wrapping without temporarily collapsing the visible field.
  const measure = h("textarea", { class: "chat-input composer-measure", rows: 1, tabindex: -1, "aria-hidden": "true" });
  const draft = h("div", { class: "composer-draft" }, input, measure);
  const send = h("button", { class: "send-btn", type: "button", title: "Send (Enter)", "aria-label": "Send message" }, svg(ICONS.arrowUp, 15));
  // Speech lands in the field as text and is never sent on its own. Only hosts with a speech service offer it.
  const mic = actions.dictation ? h("button", { class: "mic-btn", type: "button", title: "Hold to talk (Ctrl+Alt)", "aria-label": "Hold to talk (Ctrl+Alt)" }, svg(ICONS.mic, 13)) : null;
  const live = h("div", { class: "live-line", role: "status", "aria-label": "Dictation" });
  live.hidden = true;
  const wave = h("span", { class: "wave", "aria-hidden": "true" });
  for (let i = 0; i < 24; i += 1) wave.append(document.createElement("i"));
  const said = h("span", { class: "said" });
  live.append(h("span", { class: "dictation-label", text: "Listening" }), wave, said);
  const line = h("div", { class: "composer-line" }, agents, h("span", { class: "composer-rule", "aria-hidden": "true" }), draft, mic, send);
  const bar = h("div", { class: "chat-bar" }, live, tray, line);

  const el = h("div", { class: "view prompt-view" }, h("div", { class: "chat-body" }, log, asks, bar));

  let sending = false;
  let renderedFingerprint = "";
  let draftHeight = 20;

  function resizeDraft() {
    measure.value = input.value;
    const next = cappedDraftHeight(measure.scrollHeight);
    draft.style.height = `${next}px`;
    send.disabled = sending || !input.value.trim() || !!dictation?.listening;
    if (next !== draftHeight) { draftHeight = next; onHeightChange(); }
  }
  if (typeof ResizeObserver !== "undefined") {
    let width = 0;
    new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resizeDraft();
    }).observe(draft);
  }

  async function submit() {
    const typed = input.value.trim();
    if (!typed || sending || dictation?.listening) return;
    // The logos are the address. A message that already names agents with @ keeps the owner's own routing.
    const to = recipients();
    const addressed = /(^|\s)@[A-Za-z0-9-]/.test(typed) || to.length === 0 ? typed : `${to.map((t) => `@${t.name}`).join(" ")} ${typed}`;
    // Agents run on this machine, so a path is all they need to open the file.
    const files = State.pendingFiles;
    const text = files.length ? `${addressed}${ATTACHED}${files.map((f) => f.path ?? f.name).join("\n")}` : addressed;
    State.pendingFiles = [];
    syncFiles();
    input.value = "";
    sending = true;
    resizeDraft();
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: text });
    State.notify();
    onHeightChange();
    try {
      // A successful send needs no receipt bubble; the agent's reply is the confirmation. Failures still show below.
      await actions.send(text);
    } catch (err) {
      // Stay in the message view and say why: a wrong or missing @name should be fixable without losing the text.
      State.chatHistory.push({ id: nextId++, role: "assistant", content: `Not sent: ${String(err instanceof Error ? err.message : err).slice(0, 160)}` });
      input.value = typed;
      State.pendingFiles = files;
      syncFiles();
      Sound.play("error");
    } finally {
      sending = false;
      resizeDraft();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  let dictation: Dictation | null = null;
  const showNotice = (text: string, bad: boolean) => {
    State.chatHistory.push({ id: nextId++, role: "assistant", content: bad ? text : `(${text})` });
    State.notify();
    onHeightChange();
  };
  if (mic && actions.dictation) {
    const bars = [...wave.children] as HTMLElement[];
    dictation = createDictation(actions.dictation(), {
      onListening(on) {
        mic.classList.toggle("on", on);
        mic.setAttribute("aria-pressed", String(on));
        bar.classList.toggle("listening", on);
        live.hidden = !on;
        input.readOnly = on;
        send.disabled = on || sending || !input.value.trim();
        if (on) { said.textContent = "Listening…"; Sound.play("blip"); }
        onHeightChange();
      },
      onLive(text) { said.textContent = text; },
      onLevel(level) {
        const now = performance.now();
        wave.classList.toggle("hearing", level > 0.045);
        bars.forEach((bar, i) => { bar.style.transform = `scaleY(${Math.min(1, 0.16 + level * 7 * (0.55 + 0.45 * Math.sin(now / 140 + i * 0.9))).toFixed(3)})`; });
      },
      onText(words) {
        const before = input.value;
        input.value = `${before && !/\s$/.test(before) ? `${before} ` : before}${words}`;
        resizeDraft();
        input.focus();
      },
      onNotice: showNotice,
    });
    // Hold to talk; letting go (or the pointer leaving) ends it.
    mic.addEventListener("pointerdown", (e) => { e.preventDefault(); try { mic.setPointerCapture(e.pointerId); } catch { /* no capture: pointerleave covers it */ } void dictation!.start(); });
    for (const type of ["pointerup", "pointercancel"] as const) mic.addEventListener(type, () => dictation!.stop());
    mic.addEventListener("lostpointercapture", () => dictation!.stop());
    mic.addEventListener("pointerleave", (e) => { if (!mic.hasPointerCapture(e.pointerId)) dictation!.stop(); });
    mic.addEventListener("keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); void dictation!.start(); }
    });
    mic.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); dictation!.stop(); }
    });
    mic.addEventListener("blur", () => dictation!.stop());
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("input", () => { resizeDraft(); syncFiles(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the field
  });

  return {
    el,
    sync() {
      const fingerprint = JSON.stringify(State.chatHistory.map((message) => [message.id, message.content, message.link, message.dismissTaskId]));
      if (fingerprint !== renderedFingerprint) {
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        renderedFingerprint = fingerprint;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m, actions, onHeightChange));
        if (nearBottom) log.scrollTop = log.scrollHeight;
      }
      syncAgents();
      syncFiles();
      input.disabled = sending;
      if (mic) mic.disabled = sending;
      send.disabled = sending || !input.value.trim() || !!dictation?.listening;
    },
    activate() { requestAnimationFrame(resizeDraft); },
    deactivate() { dictation?.stop(); },
    // The tray and the one-tap starts sit above the line, so they count toward how tall the island needs to be.
    get draftHeight() { return (dictation?.listening ? 64 : draftHeight) + (tray.hidden ? 0 : 34) + (asks.hidden ? 0 : 34); },
    focus() {
      input.focus();
    },
    talk(active) {
      void debugLog(`composer.talk(${active}) dictation=${dictation ? "present" : "null"}`);
      if (!dictation) return;
      if (active) void dictation.start(); else dictation.stop();
    },
  };
}
