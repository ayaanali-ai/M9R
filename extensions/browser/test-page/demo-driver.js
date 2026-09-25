(function () {
  "use strict";

  const send = (msg) => document.dispatchEvent(new CustomEvent("m9r:presence", { detail: JSON.stringify(msg) }));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let sequence = 0;
  const step = (id, action, selector, pause, scrollTo, claimed = false) => ({
    msg: { id: `demo-${++sequence}`, agent: id, provider: id, action, message: action, target: { selector }, claimed, claimMs: claimed ? 1800 : 0, text: "must never appear" },
    pause,
    scrollTo,
  });

  const script = [
    step("claude", "reading pricing", "#pricing", 900),
    step("codex", "reading shipping policy", "#shipping", 900),
    step("opencode", "checking returns", "#returns", 1100),
    step("claude", "copying volume rates", "#pricing + p", 1000),
    step("codex", "typing in #email", "#email", 1000, "#contact", true),
    step("opencode", "typing order number", "#order", 900),
    step("claude", "typing in #message", "#message", 1200, undefined, true),
    step("codex", "clicking #submit", "#submit", 1500, undefined, true),
  ];

  let running = false;
  async function play() {
    if (running) return;
    running = true;
    window.scrollTo({ top: 0 });
    await wait(300);
    for (const { msg, pause, scrollTo } of script) {
      if (scrollTo) {
        document.querySelector(scrollTo).scrollIntoView({ behavior: "smooth", block: "start" });
        await wait(700);
      }
      send(msg);
      await wait(pause);
    }
    running = false;
  }

  document.getElementById("replay").addEventListener("click", play);
  window.addEventListener("load", () => setTimeout(play, 600));
})();
