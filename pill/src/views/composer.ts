// Message view: type anything, address agents with @handle, send. Replies from agents appear below.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { createDictation, type Dictation } from "../core/speech";
import { State, type ChatMessage, type LinkOffer } from "../core/state";
import type { SessionRow } from "../core/transport";
import { buildModelPicker } from "./views";
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
  // The agent's own reply gets the same bubble treatment as the user's message (light/white here, blue for "user").
  const reply = h("div", { class: "bubble", text: message.content });
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

/** The @handle being typed at the caret, if any: its start index and the partial text after the @. */
export function mentionAt(text: string, caret: number): { start: number; partial: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([A-Za-z0-9-]{0,38})$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, partial: m[2].toLowerCase() } : null;
}

/** Keep the draft readable without allowing a pasted document to consume the island. */
export function cappedDraftHeight(scrollHeight: number): number {
  return Math.max(48, Math.min(120, Number.isFinite(scrollHeight) ? scrollHeight : 48));
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const suggest = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log", role: "log", "aria-label": "Conversation" });
  const input = h("textarea", {
    class: "chat-input",
    rows: 2,
    placeholder: "Ask your agents anything…",
    "aria-label": "Message your agents",
    spellcheck: "false",
    autocomplete: "off",
  });
  // The invisible twin measures wrapping without temporarily collapsing the visible field.
  const measure = h("textarea", { class: "chat-input composer-measure", rows: 1, tabindex: -1, "aria-hidden": "true" });
  const draft = h("div", { class: "composer-draft" }, input, measure);
  const send = h("button", { class: "send-btn", type: "button", title: "Send (Enter)", "aria-label": "Send message" }, svg(ICONS.arrowUp, 15));
  // Speech lands in the field as text and is never sent on its own. Only hosts with a speech service offer it.
  const mic = actions.dictation ? h("button", { class: "mic-btn", type: "button", title: "Hold to talk (Ctrl+Alt+M)", "aria-label": "Hold to talk (Ctrl+Alt+M)" }, svg(ICONS.mic, 13)) : null;
  const live = h("div", { class: "live-line", role: "status", "aria-label": "Dictation" });
  live.hidden = true;
  const wave = h("span", { class: "wave", "aria-hidden": "true" });
  for (let i = 0; i < 24; i += 1) wave.append(document.createElement("i"));
  const said = h("span", { class: "said" });
  live.append(h("span", { class: "dictation-label", text: "Listening" }), wave, said);
  const modelLabel = h("span", { class: "composer-model-label" });
  const model = h("button", {
    class: "composer-model", type: "button", title: "Choose provider, model and reasoning", "aria-label": "Choose provider, model and reasoning",
  }, svg(ICONS.layers, 12), modelLabel, h("span", { class: "composer-chevron", text: "⌄", "aria-hidden": "true" }));
  model.hidden = !actions.selectModel;
  const hint = h("span", { class: "composer-hint", text: "Shift + Enter for a new line" });
  const footer = h("div", { class: "composer-footer" }, model, hint, mic, send);
  const bar = h("div", { class: "chat-bar" }, draft, live, footer);

  const el = h("div", { class: "view prompt-view" }, h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, log, suggest, bar)));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedFingerprint = "";
  let suggestKey = "";
  let draftHeight = 48;

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

  function syncModel() {
    const handle = /(?:^|\s)@([A-Za-z0-9-]{1,38})(?=\s|$)/.exec(input.value)?.[1]?.toLowerCase();
    const agent = State.models?.agents.find((entry) => entry.handle === handle)
      ?? State.models?.agents.find((entry) => entry.handle === State.focusTask?.name)
      ?? State.models?.agents[0];
    const chosen = agent?.selectedModel ?? agent?.currentModel;
    const label = agent?.models.find((entry) => entry.id === chosen)?.label ?? chosen;
    modelLabel.textContent = agent ? `@${agent.handle}${label ? ` · ${label}` : " · Choose model"}` : "Providers & models";
    model.dataset.handle = agent?.handle ?? "";
  }
  const modelPicker = actions.selectModel ? buildModelPicker(actions) : null;
  const modelPopover = modelPicker ? h("div", { class: "composer-model-popover" }, modelPicker.el) : null;
  // The island clips its content through several nested overflow:hidden / clip-path ancestors
  // (the chat card, the view-swap container, the island's own rounded-corner mask). A popover
  // anchored inside that tree gets silently clipped no matter how it's positioned, so instead it's
  // parented straight onto <body> and placed with position:fixed against the button's live screen
  // rect -- fully outside that clipping chain -- and repositioned on every open in case the island
  // itself moved or resized since the last time.
  if (modelPopover) {
    modelPopover.hidden = true;
    modelPopover.style.position = "fixed";
    document.body.append(modelPopover);
  }
  function closeModelPopover() {
    if (!modelPopover || modelPopover.hidden) return;
    modelPopover.hidden = true;
    modelPicker?.el.classList.remove("on");
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("keydown", onPopoverKeydown, true);
    window.removeEventListener("resize", positionModelPopover);
  }
  function onOutsidePointer(e: PointerEvent) {
    if (modelPopover && !modelPopover.contains(e.target as Node) && e.target !== model && !model.contains(e.target as Node)) closeModelPopover();
  }
  function onPopoverKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); closeModelPopover(); }
  }
  function positionModelPopover() {
    if (!modelPopover) return;
    const anchor = model.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(460, window.innerWidth - 32);
    const spaceAbove = anchor.top - margin;
    const spaceBelow = window.innerHeight - anchor.bottom - margin;
    const openDown = spaceBelow > spaceAbove;
    const height = Math.max(140, Math.min(320, (openDown ? spaceBelow : spaceAbove) - margin));
    modelPopover.style.width = `${width}px`;
    modelPopover.style.height = `${height}px`;
    modelPopover.style.left = `${Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16))}px`;
    if (openDown) {
      modelPopover.style.top = `${anchor.bottom + margin}px`;
      modelPopover.style.bottom = "auto";
    } else {
      modelPopover.style.top = "auto";
      modelPopover.style.bottom = `${window.innerHeight - anchor.top + margin}px`;
    }
  }
  model.addEventListener("click", () => {
    if (!modelPopover) return;
    const task = State.tasks.find((entry) => entry.name === model.dataset.handle);
    if (task) actions.setFocus(task.id);
    const opening = modelPopover.hidden;
    if (opening) {
      positionModelPopover();
      modelPopover.hidden = false;
      // buildModelPicker's root carries the island's generic `.view` class, which is opacity:0 /
      // pointer-events:none until the island's own view-switcher adds `.on` -- this popover isn't
      // driven by that switcher, so add it directly or the picker stays invisible and unclickable.
      modelPicker!.el.classList.add("on");
      modelPicker!.activate?.();
      document.addEventListener("pointerdown", onOutsidePointer, true);
      document.addEventListener("keydown", onPopoverKeydown, true);
      window.addEventListener("resize", positionModelPopover);
    } else {
      closeModelPopover();
    }
  });

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
        resizeDraft();
        syncModel();
      });
      suggest.append(chip);
    }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || sending || dictation?.listening) return;
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
      input.value = text;
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
        renderSuggestions();
        resizeDraft();
        syncModel();
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
  input.addEventListener("input", () => { renderSuggestions(); resizeDraft(); syncModel(); });
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
      renderSuggestions();
      syncModel();
      input.disabled = sending;
      if (mic) mic.disabled = sending;
      send.disabled = sending || !input.value.trim() || !!dictation?.listening;
      if (modelPopover && !modelPopover.hidden) modelPicker!.sync();
    },
    activate() { requestAnimationFrame(resizeDraft); },
    deactivate() { dictation?.stop(); closeModelPopover(); },
    get draftHeight() { return dictation?.listening ? 120 : draftHeight; },
    focus() {
      input.focus();
    },
    talk(active) {
      if (!dictation) return;
      if (active) void dictation.start(); else dictation.stop();
    },
  };
}
