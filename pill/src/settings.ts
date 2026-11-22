import "./settings.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS, type Settings } from "./core/state";

// Resolved via new URL(..., import.meta.url) rather than default imports: the
// repo-root tsconfig also checks this file under Next's image typings, where a
// .webp import is StaticImageData, not a URL string. Vite bundles both forms.
const windowIconUrl = new URL("./assets/m9r-site/window-icon.webp", import.meta.url).href;
const sizeGripUrl = new URL("./assets/m9r-site/size-grip.svg", import.meta.url).href;

type GlowStyle = Settings["glowStyle"];
type SaveState = "idle" | "saved" | "offline";

const VOICE_RATES = [0.75, 1, 1.25, 1.5] as const;
// No "never": the notch reads autoCloseInterval as a plain delay in seconds, and
// has no "don't collapse" meaning for 0 or Infinity -- so only real delays here.
const AUTO_CLOSE = [10, 15, 30, 60] as const;
const GLOW_STYLES: ReadonlyArray<{ value: GlowStyle; label: string }> = [
  { value: "status", label: "Status" },
  { value: "rainbow", label: "Rainbow" },
  { value: "off", label: "Off" },
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const root = document.getElementById("settings-root")!;
let settings: Settings = { ...DEFAULT_SETTINGS };
let saveState: SaveState = "idle";

type UpdatePhase = "checking" | "up_to_date" | "available" | "applying" | "failed" | "unconfigured";
interface UpdateCheckState {
  phase: UpdatePhase;
  currentVersion?: string;
  availableVersion?: string;
  error?: string;
}
let updateState: UpdateCheckState = { phase: "checking" };

/** Coerces whatever the backend (or an event) hands us into a full Settings,
 * field by field, falling back to the defaults for anything missing or malformed. */
function normalize(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (typeof r.soundEnabled === "boolean") out.soundEnabled = r.soundEnabled;
  if (num(r.soundVolume)) out.soundVolume = r.soundVolume;
  if (num(r.autoCloseInterval) && r.autoCloseInterval > 0) out.autoCloseInterval = r.autoCloseInterval;
  if (typeof r.voiceEnabled === "boolean") out.voiceEnabled = r.voiceEnabled;
  if (num(r.voiceRate)) out.voiceRate = Math.min(1.5, Math.max(0.5, r.voiceRate));
  if (r.glowStyle === "status" || r.glowStyle === "rainbow" || r.glowStyle === "off") out.glowStyle = r.glowStyle;
  if (r.glowColor === null || (typeof r.glowColor === "string" && HEX_COLOR.test(r.glowColor))) {
    out.glowColor = r.glowColor === null ? null : r.glowColor.toLowerCase();
  }
  if (r.approvalDefault === "ask_some" || r.approvalDefault === "always_ask") out.approvalDefault = r.approvalDefault;
  return out;
}

/** Optimistic: local state and the screen change first, the backend is told after.
 * Sends the whole Settings object flat, the same shape the notch's own save uses. */
async function update(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  render();
  try {
    await invoke("save_settings", { ...settings });
    saveState = "saved";
  } catch {
    // No backend (or it refused) -- the change still shows here; it just isn't persisted.
    saveState = "offline";
  }
  renderStatus();
}

/** Parses the JSON `m9r-cli update check` returns, via the check_for_update Tauri command. */
function parseUpdateResult(raw: string): UpdateCheckState {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const phase = data.phase;
    if (phase === "up_to_date" || phase === "available" || phase === "failed") {
      return {
        phase,
        currentVersion: typeof data.currentVersion === "string" ? data.currentVersion : undefined,
        availableVersion: typeof data.availableVersion === "string" ? data.availableVersion : undefined,
        error: typeof data.error === "string" ? data.error : undefined,
      };
    }
    return { phase: "failed", error: "Unexpected response from the update checker." };
  } catch {
    return { phase: "failed", error: "Unexpected response from the update checker." };
  }
}

async function checkForUpdate(): Promise<void> {
  updateState = { ...updateState, phase: "checking" };
  render();
  try {
    const raw = await invoke<string>("check_for_update");
    updateState = parseUpdateResult(raw);
  } catch (error) {
    // No desktop backend, or update-config.json doesn't exist yet (older install, or this
    // build was never released through the signed pipeline) -- not a failure to alarm over.
    const message = error instanceof Error ? error.message : String(error);
    updateState = message.includes("not configured")
      ? { phase: "unconfigured" }
      : { phase: "failed", error: message };
  }
  render();
}

async function applyUpdate(): Promise<void> {
  if (updateState.phase !== "available" || !updateState.availableVersion) return;
  updateState = { ...updateState, phase: "applying" };
  render();
  try {
    await invoke("apply_update", { version: updateState.availableVersion });
    // From here the installer stops this very process and relaunches it; nothing more to render.
  } catch (error) {
    updateState = { ...updateState, phase: "failed", error: error instanceof Error ? error.message : String(error) };
    render();
  }
}

async function previewVoice(): Promise<void> {
  try {
    await invoke("preview_voice_rate", { rate: settings.voiceRate });
  } catch {
    // Nothing to speak through without the desktop backend; the button stays harmless.
  }
}

/** Small element helper. Text only ever goes in via textContent, never innerHTML --
 * settings can arrive over IPC/events, so nothing from them is ever read as markup. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** A row of jelly pills where the chosen one is the primary blue and the rest are
 * neutral -- the same pairing the memory screen uses for its All/Global filter. */
function choiceGroup<T>(
  key: string,
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const group = el("div", "settings-choices");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const option of options) {
    const active = option.value === current;
    const button = el("button", `ds-pill-button settings-choice${active ? "" : " neutral"}`, option.label);
    button.type = "button";
    button.dataset.key = `${key}:${option.label}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(active));
    button.addEventListener("click", () => {
      if (!active) onPick(option.value);
    });
    group.append(button);
  }
  return group;
}

const onOff = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
] as const;

function groupHead(title: string, value: string): HTMLElement {
  const head = el("div", "settings-head");
  head.append(el("h2", "settings-label", title), el("span", "ds-scrap settings-value", value));
  return head;
}

function renderSound(): HTMLElement {
  const group = el("section", "settings-group");
  group.append(
    groupHead("Sound", settings.soundEnabled ? "on" : "off"),
    el("p", "settings-note", "A soft chime when an agent finishes or needs you."),
    choiceGroup("sound", "Sound", onOff, settings.soundEnabled, (v) => void update({ soundEnabled: v })),
  );
  return group;
}

function renderVoice(): HTMLElement {
  const group = el("section", "settings-group");
  const toggle = choiceGroup("voice", "Spoken updates", onOff, settings.voiceEnabled, (v) => void update({ voiceEnabled: v }));
  const preview = el("button", "ds-chrome-button settings-preview", "Preview");
  preview.type = "button";
  preview.dataset.key = "voice:preview";
  preview.title = `Hear ${formatRate(settings.voiceRate)} speed`;
  preview.addEventListener("click", () => void previewVoice());
  const row = el("div", "settings-row");
  row.append(toggle, preview);

  group.append(
    groupHead("Spoken updates", settings.voiceEnabled ? formatRate(settings.voiceRate) : "off"),
    el("p", "settings-note", "Say short updates out loud — a task finished, an agent needs you."),
    row,
  );

  const sub = el("div", `settings-sub${settings.voiceEnabled ? "" : " is-muted"}`);
  sub.append(el("span", "settings-sublabel", "Speed"));
  sub.append(
    choiceGroup(
      "rate",
      "Speaking speed",
      VOICE_RATES.map((r) => ({ value: r as number, label: formatRate(r) })),
      settings.voiceRate,
      (v) => void update({ voiceRate: v }),
    ),
  );
  group.append(sub);
  return group;
}

function renderAutoClose(): HTMLElement {
  const group = el("section", "settings-group");
  group.append(
    groupHead("Auto-close", `${Math.round(settings.autoCloseInterval)}s`),
    el("p", "settings-note", "How long the notch stays open after things go quiet."),
    choiceGroup(
      "autoclose",
      "Auto-close delay",
      AUTO_CLOSE.map((s) => ({ value: s as number, label: `${s}s` })),
      settings.autoCloseInterval,
      (v) => void update({ autoCloseInterval: v }),
    ),
  );
  return group;
}

function renderGlow(): HTMLElement {
  const group = el("section", "settings-group");
  group.append(
    groupHead("Edge glow", settings.glowStyle),
    el("p", "settings-note", "How the notch’s edge lights up: by what’s happening, a living rainbow, or never."),
    choiceGroup("glow", "Edge glow style", GLOW_STYLES, settings.glowStyle, (v) => void update({ glowStyle: v })),
  );

  const sub = el("div", `settings-sub${settings.glowStyle === "off" ? " is-muted" : ""}`);
  sub.append(el("span", "settings-sublabel", "Tint"));

  const swatch = el("label", "settings-swatch");
  swatch.title = "Choose a custom edge-glow color";
  const input = el("input", "settings-color");
  input.type = "color";
  input.dataset.key = "glow:color";
  input.value = settings.glowColor ?? "#ffffff";
  input.setAttribute("aria-label", "Custom edge-glow color");
  if (settings.glowColor === null) swatch.classList.add("is-auto");
  const tintName = el("span", "settings-tint-name", settings.glowColor ?? "Status colors");
  // "input" fires continuously while the picker is open: preview locally only, and
  // commit (save + re-render) on "change" so the open picker isn't torn down mid-drag.
  input.addEventListener("input", () => {
    swatch.classList.remove("is-auto");
    tintName.textContent = input.value;
  });
  input.addEventListener("change", () => void update({ glowColor: input.value.toLowerCase() }));
  swatch.append(input);
  sub.append(swatch, tintName);

  if (settings.glowColor !== null) {
    const reset = el("button", "ds-chrome-button settings-reset", "Use status colors");
    reset.type = "button";
    reset.dataset.key = "glow:reset";
    reset.addEventListener("click", () => void update({ glowColor: null }));
    sub.append(reset);
  }
  group.append(sub);
  return group;
}

const APPROVAL_DEFAULTS: ReadonlyArray<{ value: Settings["approvalDefault"]; title: string; note: string }> = [
  { value: "ask_some", title: "Ask for some actions", note: "Before actions that may share your information or make important changes." },
  { value: "always_ask", title: "Always ask", note: "Before any action." },
];

/** A stack of selectable cards with a checkmark on the active one, rather than a row
 * of pills -- for a choice between policies, not a single value. */
function renderApprovalDefault(): HTMLElement {
  const group = el("section", "settings-group");
  group.append(
    groupHead("Approval defaults", settings.approvalDefault === "always_ask" ? "always ask" : "ask for some"),
    el("p", "settings-note", "How often M9R checks with you before an agent acts."),
  );
  const stack = el("div", "settings-policy");
  stack.setAttribute("role", "radiogroup");
  stack.setAttribute("aria-label", "Approval defaults");
  for (const option of APPROVAL_DEFAULTS) {
    const active = option.value === settings.approvalDefault;
    const card = el("button", `settings-policy-option${active ? " is-active" : ""}`);
    card.type = "button";
    card.dataset.key = `approval:${option.value}`;
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(active));
    card.append(
      el("span", "settings-policy-title", option.title),
      el("span", "settings-policy-note", option.note),
    );
    if (active) card.append(el("span", "settings-policy-check", "✓"));
    card.addEventListener("click", () => {
      if (!active) void update({ approvalDefault: option.value });
    });
    stack.append(card);
  }
  group.append(stack);
  return group;
}

function renderUpdates(): HTMLElement | null {
  if (updateState.phase === "unconfigured") return null; // nothing to show on a dev build or one never released
  const group = el("section", "settings-group");
  const current = updateState.currentVersion ? `v${updateState.currentVersion}` : "";

  let valueText = current || (updateState.phase === "checking" ? "checking…" : "unknown");
  let note = "M9R checks for a signed, newer release. Nothing installs without you clicking the button below.";
  if (updateState.phase === "checking") note = "Checking for a newer version…";
  if (updateState.phase === "failed") note = updateState.error ?? "Could not check for updates right now.";

  group.append(groupHead("Updates", valueText), el("p", "settings-note", note));

  if (updateState.phase === "available" && updateState.availableVersion) {
    const row = el("div", "settings-row");
    const button = el("button", "ds-pill-button settings-update-button", `Update to v${updateState.availableVersion}`);
    button.type = "button";
    button.dataset.key = "update:apply";
    button.addEventListener("click", () => void applyUpdate());
    row.append(button);
    group.append(row);
  } else if (updateState.phase === "applying") {
    const row = el("div", "settings-row");
    row.append(el("span", "settings-update-progress", "Updating — M9R will restart in a moment…"));
    group.append(row);
  } else if (updateState.phase === "checking") {
    // no action yet
  } else {
    const row = el("div", "settings-row");
    const button = el("button", "ds-chrome-button settings-check-button", "Check now");
    button.type = "button";
    button.dataset.key = "update:check";
    button.addEventListener("click", () => void checkForUpdate());
    row.append(button);
    group.append(row);
  }
  return group;
}

function statusText(): string {
  if (saveState === "saved") return "Saved";
  if (saveState === "offline") return "Not saved — no desktop backend";
  return "Changes save as you make them";
}

function renderStatus(): void {
  const label = root.querySelector<HTMLElement>(".settings-status-text");
  if (label) label.textContent = statusText();
}

function render(): void {
  // Whole-screen rebuild, so carry focus and the pane's scroll across it.
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const scrollTop = root.querySelector(".settings-pane")?.scrollTop ?? 0;

  // Nav bar -- the site's cream bar, "M9R" left, a "Prints · 0"-style label right.
  const nav = el("nav", "ds-nav settings-nav");
  const label = el("span", "settings-nav-label");
  label.append(el("span", "settings-nav-glyph", "▧"), document.createTextNode(" Settings"));
  nav.append(el("span", "settings-brand", "M9R"), label);

  // Hero -- eyebrow, one display headline, serif lede.
  const hero = el("header", "settings-hero");
  hero.append(
    el("small", "ds-eyebrow", "Settings"),
    el("h1", "ds-headline settings-title", "How M9R behaves."),
    el("p", "settings-lede", "Sound, voice, and the notch’s glow. Every change applies right away."),
  );

  // The retro window holding the controls.
  const win = el("section", "ds-window settings-window");
  win.setAttribute("aria-label", "Settings");

  const title = el("div", "ds-window-title");
  const titleLabel = el("span");
  const icon = el("img");
  icon.src = windowIconUrl;
  icon.alt = "";
  titleLabel.append(icon, document.createTextNode("Preferences"));
  title.append(titleLabel);

  const toolbar = el("div", "ds-window-toolbar");
  toolbar.append(el("span", "", "Notch"), el("span", "", "Voice"), el("span", "", "Glow"));

  const pane = el("div", "ds-window-pane settings-pane");
  pane.append(renderSound(), renderVoice(), renderAutoClose(), renderGlow(), renderApprovalDefault());
  const updates = renderUpdates();
  if (updates) pane.append(updates);

  const status = el("div", "ds-window-status");
  const grip = el("img");
  grip.src = sizeGripUrl;
  grip.alt = "";
  status.append(el("span", "settings-status-text", statusText()), grip);

  win.append(title, toolbar, pane, status);
  root.replaceChildren(nav, hero, win);

  pane.scrollTop = scrollTop;
  if (focusKey) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

async function refresh(): Promise<void> {
  try {
    settings = normalize(await invoke<unknown>("read_settings"));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  render();
}

async function start(): Promise<void> {
  render();
  await refresh();
  void checkForUpdate();
  try {
    await listen<unknown>("settings-update", (event) => {
      // Use the pushed settings when the event carries them; otherwise re-read.
      if (event.payload && typeof event.payload === "object") {
        settings = normalize(event.payload);
        render();
      } else {
        void refresh();
      }
    });
  } catch {
    // No live backend yet -- the window still renders, just without push updates.
  }
}

void start();
