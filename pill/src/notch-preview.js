import { createDesktopTransport, tauriInvoke } from "./shells/desktop";
import { addressMessage } from "./core/address-message";
import { providerLogo } from "./views/provider";
import { createDictation } from "./core/speech";
import { listen } from "@tauri-apps/api/event";
const $ = selector => document.querySelector(selector);
const notch = $("#notch"), toggle = $("#toggle"), sheet = $("#sheet"), thread = $("#thread");
const invoke = tauriInvoke();
const host = invoke ? createDesktopTransport(invoke) : null;
if (!host) for (const provider of ["claude","codex"]) $("#faces").append(providerLogo(provider,20).querySelector("img"));
function setOpen(open) {
  notch.classList.toggle("open",open);
  sheet.inert = !open;
  if (!open) {
    dictation?.stop();
    host?.focusWindow(false);
  }
  toggle.setAttribute("aria-expanded",String(open));
  toggle.setAttribute("aria-label",open ? "Collapse conversation" : "Open conversation");
}
toggle.onclick = () => setOpen(sheet.inert);
document.onkeydown = event => { if(event.key === "Escape"){setOpen(false);toggle.focus();} };
function message(name,body){
  const row = document.createElement("div"), label = document.createElement("small"), bubble = document.createElement("p");
  row.className = name === "You" ? "msg mine" : "msg";
  label.textContent = name; bubble.textContent = body; row.append(label,bubble);thread.append(row);
}
if (!host) {
message("You","Can you two put together a weekend plan?");
message("Claude","I found a trail for Saturday. Codex, can you pick a picnic spot nearby?");
message("Codex","How about the park by the trailhead? We can leave the car there.");
message("Claude","Perfect. I’ll put both in the note.");
}
let providers = ["claude", "codex"];
const selected = new Set(["claude"]);
const input = $("input");
const draftKey = "m9r-notch-draft";
const sendStatus = document.createElement("output");
sendStatus.className = "send-status";
sendStatus.setAttribute("aria-live", "polite");
let dictation;
const display = name => name[0].toUpperCase() + name.slice(1);
function updateTargets() {
  const addressed = addressMessage(input.value || "…", [...selected]);
  const handles = [...new Set(Array.from(addressed.matchAll(/(?:^|\s)@([\w-]+)/g), match => match[1].toLowerCase()))];
  for (const button of $("#targets").children) {
    button.setAttribute("aria-pressed", String(handles.includes(button.dataset.provider)));
  }
  input.placeholder = "Message " + [...selected].map(display).join(" & ");
  const unknown = handles.find(name => !providers.includes(name));
  input.setCustomValidity(unknown ? "Unknown recipient @" + unknown : "");
  return handles;
}
function renderTargets() {
$("#targets").replaceChildren();
for (const provider of providers) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.provider = provider;
  button.title = button.ariaLabel = "Address " + display(provider);
  button.append(providerLogo(provider,18));
  button.onclick = () => {
    if (selected.has(provider)) selected.delete(provider);
    else selected.add(provider);
    if (!selected.size) selected.add(providers[0]);
    updateTargets();
    input.focus();
  };
  $("#targets").append(button);
}
}
renderTargets();
input.oninput = () => {
  if (host) sessionStorage.setItem(draftKey, input.value);
  updateTargets();
};
updateTargets();
$("form").onsubmit = async event => {
  event.preventDefault();
  if (!input.value.trim()) return;
  if (host) {
    if (input.disabled || !providers.length) return;
    const draft = input.value;
    input.disabled = true;
    sendStatus.textContent = "Sending…";
    try {
      await host.send(addressMessage(draft, [...selected]));
      input.value = "";
      sessionStorage.removeItem(draftKey);
      sendStatus.textContent = "Accepted";
    } catch (error) { sendStatus.textContent = String(error); }
    finally { input.disabled = false; updateTargets(); input.focus(); }
    return;
  }
  const nearBottom = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 16;
  const recipients = updateTargets();
  message("You → " + recipients.map(display).join(" & "), input.value.trim());
  thread.lastElementChild.classList.add("mine");
  input.value = "";
  updateTargets();
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
};
for(const axis of ["w","h"]){
  const saved = Number(localStorage.getItem("notch-preview-"+axis));
  if(saved > 0) notch.style.setProperty("--"+axis,saved+"px");
}
for(const handle of document.querySelectorAll(".edge")){
  handle.onpointerdown = event => {
    const {width,height} = notch.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    handle.setPointerCapture(event.pointerId);notch.classList.add("drag");
    handle.onpointermove = e => {
      if(handle.dataset.side) notch.style.setProperty("--w",Math.min(innerWidth*.96,Math.max(310,width+2*Number(handle.dataset.side)*(e.clientX-x)))+"px");
      if(handle.matches(".bottom,.corner")) notch.style.setProperty("--h",Math.min(innerHeight*.92,Math.max(230,height+e.clientY-y))+"px");
    };
    handle.onlostpointercapture = () => {handle.onpointermove=null;notch.classList.remove("drag");localStorage.setItem("notch-preview-w",notch.offsetWidth);localStorage.setItem("notch-preview-h",notch.offsetHeight);};
  };
}

// Trace one mirrored edge. The compact lip and the sheet share the same fill,
// so fractional display scaling cannot expose a join between painted layers.
const outline = $("#outline path");
function drawOutline() {
  const {width, height} = notch.getBoundingClientRect();
  const lip = toggle.getBoundingClientRect().width;
  const expansion = Math.min(1, Math.max(0, (height - 32) / 100));
  const reach = Math.max(0, (width - lip) / 2);
  const round = 15 + 9 * expansion;
  const shoulderY = 15 + 12 * expansion;
  const flare = Math.min(14, reach * .4);
  const corner = Math.min(24, reach * .45);
  outline.setAttribute("d", [
    `M ${reach-15} 0 Q ${reach} 0 ${reach} 15`,
    `Q ${reach} ${shoulderY} ${reach-flare} ${shoulderY}`,
    `H ${corner} Q 0 ${shoulderY} 0 ${shoulderY+corner}`,
    `V ${height-round} Q 0 ${height} ${round} ${height}`,
    `H ${width-round} Q ${width} ${height} ${width} ${height-round}`,
    `V ${shoulderY+corner} Q ${width} ${shoulderY} ${width-corner} ${shoulderY}`,
    `H ${width-reach+flare} Q ${width-reach} ${shoulderY} ${width-reach} 15`,
    `Q ${width-reach} 0 ${width-reach+15} 0 Z`
  ].join(" "));
}
new ResizeObserver(drawOutline).observe(notch);
drawOutline();

if (host) {
  document.body.classList.add("desktop");
  document.querySelector("aside")?.remove();
  sheet.querySelector("strong")?.remove();
  thread.setAttribute("aria-label", "Conversation");
  $("form > button").setAttribute("aria-label", "Send message");
  const navigation = document.createElement("nav");
  navigation.setAttribute("aria-label", "Pill navigation");
  for (const [label, surface] of [["Home", "home"], ["Settings", "settings"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => location.assign("?controls=" + surface);
    navigation.append(button);
  }
  sheet.querySelector("header").append(navigation, sendStatus);
  input.value = sessionStorage.getItem(draftKey) ?? "";
  input.addEventListener("pointerdown", () => {
    void invoke("pill_set_focus", { focused: true }).then(() => input.focus()).catch(() => {});
  });
  const speech = host.createDictationEnvironment?.();
  if (speech) {
    dictation = createDictation(speech, {
      onListening: active => { if (active) sendStatus.textContent = "Listening…"; },
      onLive: () => {},
      onText: text => {
        input.value = [input.value.trim(), text].filter(Boolean).join(" ");
        input.oninput();
        sendStatus.textContent = "";
      },
      onNotice: text => { sendStatus.textContent = text; },
    });
    void listen("hold-to-talk", ({ payload }) => {
      if (payload === "pressed") {
        setOpen(true);
        host.focusWindow(true);
        void dictation.start();
      } else if (payload === "released") dictation.stop();
    }).catch(() => {});
  }
  providers = [];
  selected.clear();
  renderTargets();
  host.subscribe(snapshot => {
    if (snapshot.approvals.length) { location.replace("?controls=home"); return; }
    const next = snapshot.agents.map(agent => agent.handle);
    if (snapshot.connectionOnly || next.join() !== providers.join()) {
      providers = next;
      for (const name of selected) if (!next.includes(name)) selected.delete(name);
      if (!selected.size && next.length) selected.add(next[0]);
      renderTargets();
      $("#faces").replaceChildren(...snapshot.agents.map(agent => providerLogo(agent.provider, 24)));
    }
    if (!snapshot.connectionOnly) {
      const follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 32;
      thread.replaceChildren();
      for (const entry of snapshot.thread) message(["owner","user","you"].includes(entry.from.toLowerCase()) ? "You" : entry.from, entry.text);
      if (follow) thread.scrollTop = thread.scrollHeight;
    }
    updateTargets();
  });
  const reportBounds = () => {
    const rect = notch.getBoundingClientRect();
    host.setIslandRect(rect.x,rect.y,rect.width,rect.height);
  };
  new ResizeObserver(reportBounds).observe(notch);
  reportBounds();
}
