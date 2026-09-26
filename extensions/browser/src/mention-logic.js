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
  // "tell Codex to ...", "have OpenCode check ...": the person is directing the named agent.
  const DIRECTIVES = new Set(["tell", "ask", "have", "let", "let's", "lets", "get", "make", "ping", "message", "notify"]);
  // After a name, these words mean the sentence is about the agent, not to it ("Claude is slow today").
  const ABOUT = new Set(["is", "was", "are", "were", "has", "had", "seems", "seemed", "said", "says", "keeps", "kept", "tends", "isn't", "wasn't"]);
  const IMPERATIVE = new Set([
    "read", "open", "go", "check", "find", "search", "look", "write", "fix", "make", "tell", "ask", "run", "summarize", "summarise",
    "compare", "click", "type", "scroll", "help", "try", "use", "start", "stop", "review", "list", "show", "get", "take", "do", "please",
    "can", "could", "would", "will", "build", "add", "update", "edit", "test", "verify", "watch", "wait", "pick", "fill", "press", "send", "post",
    "split", "handle", "grab", "pull", "collect", "gather", "count", "double-check", "recheck", "confirm", "save", "copy", "paste", "submit",
  ]);

  /** A command word, allowing the third-person form that appears when several agents get different jobs ("Codex takes the history"). */
  function isCommand(word) {
    if (!word) return false;
    if (IMPERATIVE.has(word)) return true;
    if (word.endsWith("es") && IMPERATIVE.has(word.slice(0, -2))) return true;
    if (word.endsWith("s") && IMPERATIVE.has(word.slice(0, -1))) return true;
    return false;
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
      // A bare "all" only addresses everyone when a command or a comma follows ("all read the doc"); "all right" is just English.
      if (entry.name === "all") {
        const follow = lower.slice(end).match(/^\s*([,:]|[\p{L}']+)/u);
        const token = follow ? follow[1] : "";
        if (!(token === "," || token === ":" || isCommand(token))) continue;
      }
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

  /** Skips "tell", "ask", "have", "let's have" and the like; reports whether it did. */
  function skipDirective(text, index) {
    let at = index;
    let directive = false;
    for (let i = 0; i < 2; i += 1) {
      const m = text.slice(at).match(/^\s*([\p{L}']+)\s+/u);
      if (!m || !DIRECTIVES.has(m[1].toLowerCase())) break;
      at += m[0].length;
      directive = true;
    }
    return { at, directive };
  }

  /** Where each clause begins. A sentence break is a hard start; a comma, "and", ";" or "then" is a soft start that must prove itself. */
  function segmentStarts(text) {
    const starts = [{ start: 0, soft: false }];
    const re = /([.!?\n]+|,|;|\band\b|\bthen\b)\s*/gi;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index + m[0].length;
      if (at >= text.length) continue;
      starts.push({ start: at, soft: !/^[.!?\n]/.test(m[1]) });
    }
    return starts;
  }

  function parseSegment(text, from, table) {
    let at = skipFiller(text, from);
    const dir = skipDirective(text, at);
    at = dir.at;
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
    if (ABOUT.has(firstWord) && separatorKind === "space" && !dir.directive) return null;
    const explicitBreak = separatorKind === "punct";
    const strong = dir.directive || isCommand(firstWord) || explicitBreak;
    const confidence = strong || restText.trim() === "" ? "high" : "medium";
    return { found, end: at, confidence, strong };
  }

  /**
   * Who a message is addressed to when the person did not type @: agent names at the start of a sentence or clause, like
   * "Claude do this", "claude and codex, check that", "tell Codex to verify it" or "all three of you look". Names inside a
   * sentence, possessives ("Claude's pricing") and statements about an agent ("Claude is slow") are not mentions.
   */
  function detect(text, roster) {
    const source = typeof text === "string" ? text : "";
    const table = matcher(Array.isArray(roster) && roster.length ? roster : ROSTER);
    const mentions = [];
    let everyone = false;
    let confidence = "high";
    for (const seg of segmentStarts(source)) {
      const parsed = parseSegment(source, seg.start, table);
      if (!parsed) continue;
      // A clause that begins after a comma or "and" only counts when it clearly reads as a command to that agent.
      if (seg.soft && !parsed.strong) continue;
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

  /**
   * True when the message names an agent (or everyone) somewhere but the rules are not sure it is addressed to them. Those are the
   * only messages worth a second opinion; a message with no agent name needs none, and a confident one is already decided.
   */
  function needsJudgment(text, roster) {
    const source = typeof text === "string" ? text.toLowerCase() : "";
    const table = matcher(Array.isArray(roster) && roster.length ? roster : ROSTER);
    const named = table.some((entry) => {
      if (entry.name === "all") return false;
      const at = source.indexOf(entry.name);
      if (at < 0) return false;
      const before = source[at - 1];
      const after = source[at + entry.name.length];
      return !(before && /[\p{L}\p{N}_]/u.test(before)) && !(after && /[\p{L}\p{N}_]/u.test(after));
    });
    if (!named) return false;
    const found = detect(text, roster);
    return !(found.mentions.length || found.everyone) || found.confidence !== "high";
  }

  global.M9RMentions = { detect, resolveRecipients, needsJudgment, ROSTER };
})(typeof window !== "undefined" ? window : globalThis);
