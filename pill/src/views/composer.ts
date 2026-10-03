// Message view: type anything, address agents with @handle, send. Replies from agents appear below.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { createDictation, type Dictation } from "../core/speech";
import { State, type ChatMessage, type LinkOffer } from "../core/state";
import type { SessionRow } from "../core/transport";
import type { ViewActions, ViewHost } from "./views";

let nextId = 1;

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

function bubble(message: ChatMessage, actions: ViewActions, onHeightChange: () => void): HTMLElement {
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: message.content }));
  }
  const reply = h("div", { class: "reply", text: message.content });
  if (message.link && actions.linking) return h("div", { class: "chat-row link-row" }, reply, linkPicker(message.link, actions.linking, onHeightChange));
  return h("div", { class: "chat-row" }, reply);
}

/** The @handle being typed at the caret, if any: its start index and the partial text after the @. */
export function mentionAt(text: string, caret: number): { start: number; partial: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([A-Za-z0-9-]{0,38})$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, partial: m[2].toLowerCase() } : null;
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const suggest = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Message your agents, e.g. @claude check the pricing page…",
    spellcheck: "false",
    autocomplete: "off",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  // Speech lands in the field as text and is never sent on its own. Only hosts with a speech service offer it.
  const mic = actions.dictation ? h("button", { class: "mic-btn", type: "button", title: "Hold to talk", "aria-label": "Hold to talk" }, svg(ICONS.mic, 13)) : null;
  const live = h("div", { class: "live-line" });
  live.hidden = true;
  const wave = h("span", { class: "wave" });
  for (let i = 0; i < 7; i += 1) wave.append(document.createElement("i"));
  const said = h("span", { class: "said" });
  live.append(wave, said);
  const bar = h("div", { class: "chat-bar" }, input, live, mic, send);

  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, suggest, log, bar)));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  let suggestKey = "";

  function renderSuggestions() {
    const at = mentionAt(input.value, input.selectionStart ?? input.value.length);
    const options = at ? State.tasks.filter((t) => t.name.toLowerCase().startsWith(at.partial)) : State.tasks.length > 0 && input.value.trim() === "" ? State.tasks : [];
    const key = `${at?.start ?? -1}|${options.map((t) => t.id).join(",")}`;
    if (key === suggestKey) return;
    suggestKey = key;
    clear(suggest);
    for (const t of options.slice(0, 4)) {
      const chip = h("button", { class: "chip settled", type: "button", text: `@${t.name}` });
      chip.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field
      chip.addEventListener("click", () => {
        const where = mentionAt(input.value, input.selectionStart ?? input.value.length);
        const head = where ? input.value.slice(0, where.start) : input.value;
        const tail = where ? input.value.slice(input.selectionStart ?? input.value.length) : "";
        input.value = `${head}@${t.name} ${tail}`.replace(/\s+$/, " ");
        input.focus();
        suggestKey = "";
        renderSuggestions();
      });
      suggest.append(chip);
    }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");
    State.chatHistory.push({ id: nextId++, role: "user", content: text });
    State.notify();
    onHeightChange();
    try {
      const confirmation = await actions.send(text);
      if (typeof confirmation === "string" && confirmation) State.chatHistory.push({ id: nextId++, role: "assistant", content: confirmation });
    } catch (err) {
      // Stay in the message view and say why: a wrong or missing @name should be fixable without losing the text.
      State.chatHistory.push({ id: nextId++, role: "assistant", content: `Not sent: ${String(err instanceof Error ? err.message : err).slice(0, 160)}` });
      input.value = text;
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  let dictation: Dictation | null = null;
  let noticeTimer = 0;
  const showNotice = (text: string, bad: boolean) => {
    State.chatHistory.push({ id: nextId++, role: "assistant", content: bad ? text : `(${text})` });
    State.notify();
    onHeightChange();
    window.clearTimeout(noticeTimer);
  };
  if (mic && actions.dictation) {
    const bars = [...wave.children] as HTMLElement[];
    dictation = createDictation(actions.dictation(), {
      onListening(on) {
        mic.classList.toggle("on", on);
        live.hidden = !on;
        input.style.display = on ? "none" : "";
        if (on) { said.textContent = "Listening…"; Sound.play("blip"); }
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
        renderSuggestions();
        input.focus();
      },
      onNotice: showNotice,
    });
    // Hold to talk; letting go (or the pointer leaving) ends it.
    mic.addEventListener("pointerdown", (e) => { e.preventDefault(); try { mic.setPointerCapture(e.pointerId); } catch { /* no capture: pointerleave covers it */ } void dictation!.start(); });
    for (const type of ["pointerup", "pointercancel"] as const) mic.addEventListener(type, () => dictation!.stop());
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the field
  });

  return {
    el,
    sync() {
      const count = State.chatHistory.length;
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m, actions, onHeightChange));
        log.scrollTop = log.scrollHeight;
      }
      renderSuggestions();
      input.disabled = sending;
    },
    focus() {
      input.focus();
    },
    talk(active) {
      if (!dictation) return;
      if (active) void dictation.start(); else dictation.stop();
    },
  };
}
