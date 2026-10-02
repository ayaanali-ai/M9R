// Message view: type anything, address agents with @handle, send. Replies from agents appear below.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: message.content }));
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
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
  const bar = h("div", { class: "chat-bar" }, input, send);

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
      const chip = h("button", { class: "chip", type: "button", text: `@${t.name}` });
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
      await actions.send(text);
    } catch (err) {
      State.noteMessage = `Could not send: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`;
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
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
        for (const m of State.chatHistory) log.append(bubble(m));
        log.scrollTop = log.scrollHeight;
      }
      renderSuggestions();
      input.disabled = sending;
    },
    focus() {
      input.focus();
    },
  };
}
