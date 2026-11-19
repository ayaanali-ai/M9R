// Run with Electron as the executable. Uses only fixture-owned WebContents.
const assert = require("node:assert/strict");
const { app, BrowserWindow, WebContentsView, webContents } = require("electron");

function page(value) {
  return "data:text/html," + encodeURIComponent(
    `<!doctype html><title>Bilateral document</title><textarea id="editor">${value}</textarea>`,
  );
}

async function main() {
  const window = new BrowserWindow({ show: false });
  const owner = window.webContents;
  const agentView = new WebContentsView();
  window.contentView.addChildView(agentView);
  agentView.setVisible(false);
  const agent = agentView.webContents;
  try {
    let generation = 0;
    agent.on("did-start-navigation", details => {
      if (details.isMainFrame && !details.isSameDocument) generation++;
    });
    await Promise.all([owner.loadURL(page("owner")), agent.loadURL(page("agent"))]);
    const bind = () => ({ id: agent.id, frame: agent.mainFrame, generation });
    const read = contents => contents.mainFrame.executeJavaScript("document.querySelector('#editor').value");
    async function append(target) {
      const contents = webContents.fromId(target.id);
      if (contents !== agent || target.generation !== generation || target.frame !== contents.mainFrame) {
        throw new Error("Stale Electron document");
      }
      return target.frame.executeJavaScript(`(() => {
        const editor = document.querySelector("#editor");
        if (editor.value !== "agent") throw new Error("Unexpected starting value");
        editor.value += "\\nbackground check";
        return editor.value;
      })()`);
    }
    const focusedBefore = webContents.getFocusedWebContents()?.id;
    const target = bind();
    assert.equal(await append(target), "agent\nbackground check");
    assert.equal(await read(agent), "agent\nbackground check");
    assert.equal(await read(owner), "owner");
    assert.equal(webContents.getFocusedWebContents()?.id, focusedBefore);
    await agent.loadURL(page("fresh"));
    await assert.rejects(append(target), /Stale Electron document/);
    assert.equal(await read(agent), "fresh");
    console.log("PASS: hidden Electron document appended once, owner unchanged, stale document refused after navigation.");
  } finally {
    agent.close();
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
