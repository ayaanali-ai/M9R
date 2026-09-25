(function (global) {
  "use strict";

  const ROSTER = [
    { handle: "claude", names: ["claude code", "claude"] },
    { handle: "codex", names: ["codex"] },
    { handle: "opencode", names: ["open code", "opencode"] },
  ];
  // Words that mean the message is addressed to everyone.
  const EVERYONE = ["all three of you", "all of you", "all three", "you all", "y'all", "everybody", "everyone", "all"];
  const FILLERS = new Set(["hey", "hi", "yo", "ok", "okay", "so", "and", "then", "now", "also", "alright"]);
  // After a name, these words mean the sentence is about the agent, not to it ("Claude is slow today").
  const ABOUT = new Set(["is", "was", "are", "were", "has", "had", "seems", "seemed", "said", "says", "keeps", "kept", "tends", "isn't", "wasn't"]);
  const IMPERATIVE = new Set([
    "read", "open", "go", "check", "find", "search", "look", "write", "fix", "make", "tell", "ask", "run", "summarize", "summarise",
    "compare", "click", "type", "scroll", "help", "try", "use", "start", "stop", "review", "list", "show", "get", "take", "do", "please",
    "can", "could", "would", "will", "build", "add", "update", "edit", "test", "verify", "watch", "wait", "pick", "fill", "press", "send", "post",
  ]);

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function matcher(roster) {
    const table = [];
    for (const agent of roster) for (const name of agent.names) table.push({ handle: agent.handle, name: name.toLowerCase(), everyone: false });
    for (const name of EVERYONE) table.push({ handle: "all", name, everyone: true });
    // Longest names first so "claude code" wins over "claude" and "all three" over "all".
    table.sort((a, b) => b.name.length - a.name.length);
    return table;
  }

  function nameAt(text, index, table) {
    const lower = text.toLowerCase();
    let at = index;
    if (lower[at] === "@") at += 1;
    for (const entry of table) {
      if (!lower.startsWith(entry.name, at)) continue;
      const end = at + entry.name.length;
      const next = lower[end];
      if (next && /[\p{L}\p{N}_]/u.test(next)) continue;
      return { handle: entry.handle, everyone: entry.everyone, start: index, end };
    }
    return null;
  }

  function skipFiller(text, index) {
    let at = index;
    for (;;) {
      const rest = text.slice(at);
      const m = rest.match(/^\s*([\p{L}']+)(\s*,)?\s+/u);
      if (!m || !FILLERS.has(m[1].toLowerCase())) return at;
      at += m[0].length;
    }
  }

  /** Where each sentence begins: the start of the text, after . ! ? or a line break. */
  function segmentStarts(text) {
    const starts = [0];
    const re = /[.!?\n]+\s*/g;
    let m;
    while ((m = re.exec(text))) if (m.index + m[0].length < text.length) starts.push(m.index + m[0].length);
    return starts;
  }

  function parseSegment(text, from, table) {
    let at = skipFiller(text, from);
    while (at < text.length && /\s/.test(text[at])) at += 1;
    const found = [];
    let separatorKind = "space";
    for (;;) {
      const hit = nameAt(text, at, table);
      if (!hit) break;
      // "Claude's pricing" is about Claude; it is not addressed to it.
      if (/^['’]s\b/i.test(text.slice(hit.end))) return null;
      found.push(hit);
      let next = hit.end;
      const sep = text.slice(next).match(/^\s*(,|&|\+|\/|:|-|—|and\b|plus\b)?\s*/i);
      if (sep) {
        next += sep[0].length;
        separatorKind = sep[1] && /^[,:\-—]$/.test(sep[1]) ? "punct" : sep[1] ? "join" : "space";
      }
      const another = nameAt(text, next, table);
      if (another && !another.everyone) {
        at = next;
        continue;
      }
      at = next;
      break;
    }
    if (found.length === 0) return null;
    const restText = text.slice(at);
    const firstWord = (restText.match(/^[\p{L}']+/u) || [""])[0].toLowerCase();
    if (ABOUT.has(firstWord) && separatorKind === "space") return null;
    const explicitBreak = separatorKind === "punct";
    const confidence = explicitBreak || IMPERATIVE.has(firstWord) || restText.trim() === "" ? "high" : "medium";
    return { found, end: at, confidence };
  }

  /**
   * Who a message is addressed to when the person did not type @: agent names at the start of a sentence, like
   * "Claude do this", "claude and codex, check that" or "all three of you look". Names inside a sentence, possessives
   * ("Claude's pricing") and statements about an agent ("Claude is slow") are not mentions.
   */
  function detect(text, roster) {
    const source = typeof text === "string" ? text : "";
    const table = matcher(Array.isArray(roster) && roster.length ? roster : ROSTER);
    const mentions = [];
    let everyone = false;
    let confidence = "high";
    for (const start of segmentStarts(source)) {
      const parsed = parseSegment(source, start, table);
      if (!parsed) continue;
      if (parsed.confidence === "medium") confidence = "medium";
      for (const hit of parsed.found) {
        if (hit.everyone) everyone = true;
        else if (!mentions.some((m) => m.handle === hit.handle)) mentions.push({ handle: hit.handle, start: hit.start, end: hit.end, text: source.slice(hit.start, hit.end) });
      }
    }
    return { mentions, everyone, confidence: mentions.length || everyone ? confidence : null };
  }

  /**
   * The recipients of a message: whoever it names, otherwise whoever the last message went to, so a conversation with
   * the same agents carries on without repeating names.
   */
  function resolveRecipients(text, stickyHandles, roster) {
    const found = detect(text, roster);
    if (found.everyone) return { handles: ["all"], source: "named", confidence: found.confidence };
    if (found.mentions.length) return { handles: found.mentions.map((m) => m.handle), source: "named", confidence: found.confidence };
    const sticky = Array.isArray(stickyHandles) ? stickyHandles.filter((h) => typeof h === "string" && h) : [];
    return { handles: sticky, source: sticky.length ? "sticky" : "none", confidence: null };
  }

  global.M9RMentions = { detect, resolveRecipients, ROSTER };
})(typeof window !== "undefined" ? window : globalThis);
