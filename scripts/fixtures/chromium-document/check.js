const fixture = "http://127.0.0.1:8765/document.html";
const ownerUrl = fixture + "?role=owner";
const agentUrl = fixture + "?role=agent";

function inspect(expectedUrl, append = false) {
  const editor = document.querySelector("#fixture-editor");
  if (location.href !== expectedUrl || !(editor instanceof HTMLTextAreaElement)) {
    throw new Error("The expected fixture editor is unavailable.");
  }
  if (append) {
    if (editor.value !== "agent") throw new Error("Unexpected starting value.");
    editor.value += "\nbackground check";
  }
  return editor.value;
}

async function onlyResult(target, url, append = false) {
  const [result, ...extra] = await chrome.scripting.executeScript({ target, func: inspect, args: [url, append] });
  if (!result?.documentId || extra.length || result.frameId !== 0) throw new Error("Expected exactly one top-level document.");
  return result;
}

async function check() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const owners = tabs.filter(tab => tab.url === ownerUrl);
  const agents = tabs.filter(tab => tab.url === agentUrl);
  if (owners.length !== 1 || agents.length !== 1 || !owners[0].active || agents[0].active) {
    throw new Error("Open one owner fixture and one agent fixture in the same window. Select the owner tab.");
  }
  const owner = owners[0];
  const agent = agents[0];
  const ownerBefore = await onlyResult({ tabId: owner.id }, ownerUrl);
  const agentBefore = await onlyResult({ tabId: agent.id }, agentUrl);
  if (ownerBefore.result !== "owner" || agentBefore.result !== "agent") throw new Error("Reload both fixtures before checking.");
  const exact = { tabId: agent.id, documentIds: [agentBefore.documentId] };
  const edited = await onlyResult(exact, agentUrl, true);
  const agentAfter = await onlyResult(exact, agentUrl);
  const ownerAfter = await onlyResult({ tabId: owner.id, documentIds: [ownerBefore.documentId] }, ownerUrl);
  const [active] = await chrome.tabs.query({ currentWindow: true, active: true });
  if (edited.documentId !== agentBefore.documentId || agentAfter.result !== "agent\nbackground check"
      || ownerAfter.result !== "owner" || active?.id !== owner.id) throw new Error("The edit or active-tab check failed.");
  await chrome.tabs.reload(agent.id);
  let reloaded;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const tab = await chrome.tabs.get(agent.id);
    if (tab.status !== "complete") continue;
    reloaded = await onlyResult({ tabId: agent.id }, agentUrl);
    if (reloaded.documentId !== agentBefore.documentId) break;
  }
  if (!reloaded || reloaded.documentId === agentBefore.documentId) throw new Error("Reload did not produce a fresh document.");
  // A read against the stale ID must be refused by Chrome itself.
  const staleRejected = await chrome.scripting.executeScript({ target: exact, func: inspect, args: [agentUrl] })
    .then(() => false, () => true);
  const [stillActive] = await chrome.tabs.query({ currentWindow: true, active: true });
  if (!staleRejected || reloaded.result !== "agent" || stillActive?.id !== owner.id) throw new Error("Stale-ID or reload check failed.");
  return "PASS: inactive document appended once, owner text and selected tab unchanged, stale document ID refused after reload.";
}

document.querySelector("#run").addEventListener("click", async ({ currentTarget }) => {
  const output = document.querySelector("#result");
  currentTarget.disabled = true;
  try { output.textContent = await check(); }
  catch (error) { output.textContent = String(error); }
  finally { currentTarget.disabled = false; }
});
