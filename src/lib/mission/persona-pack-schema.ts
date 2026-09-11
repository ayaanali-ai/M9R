/**
 * Persona packs — Buzz-parity (crates/buzz-persona): a parser/loader for
 * composable, named agent personas with pack-level defaults that merge into
 * each persona's own config. Ports buzz-persona's actual job (crates/
 * buzz-persona/PERSONA_PACK_SPEC.md, read in full) — the parser/loader
 * crate, not buzz-acp's separate job of injecting the resolved prompt into
 * a live session (that's a further wiring step, not this crate's scope in
 * Buzz either).
 *
 * Deliberately adapted, not copied wholesale, for one structural reason:
 * Buzz packs are filesystem/git-distributed bundles (`.plugin/plugin.json`
 * + `agents/*.persona.md` files, skills/ directories, zip distribution,
 * OPS compatibility). OathLock is a hosted, multi-tenant web app with no
 * per-workspace filesystem to distribute a pack into — so a pack here is a
 * single JSON/YAML document a workspace owner authors in the app, with
 * personas defined inline rather than as separate files. The frontmatter
 * schema, field names, and defaults-merge semantics are ported faithfully;
 * skill-file discovery/copying and MCP-server distribution (both explicitly
 * filesystem operations in Buzz's spec) are not, since there is no
 * `$AGENT_CWD/.agents/skills/` filesystem convention to copy into here.
 */

export interface PersonaTriggers {
  mentions?: boolean;
  keywords?: string[];
  allMessages?: boolean;
}

export interface PersonaBehavioralConfig {
  subscribe?: string[];
  triggers?: PersonaTriggers;
  model?: string;
  temperature?: number;
  maxContextTokens?: number;
  threadReplies?: boolean;
  broadcastReplies?: boolean;
}

export interface PersonaMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PersonaDefinition extends PersonaBehavioralConfig {
  name: string;
  displayName: string;
  description: string;
  avatar?: string;
  skills?: string[];
  mcpServers?: PersonaMcpServer[];
  /** The markdown body — the [System] layer prompt text. See module comment: pack authors should not duplicate [Base]-layer content (tool/workspace mechanics) here, that's the harness's job, not the persona's. */
  prompt: string;
}

export interface PersonaPackManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  defaults?: PersonaBehavioralConfig;
  personas: PersonaDefinition[];
}

export class PersonaPackError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTriggers(raw: unknown, context: string): PersonaTriggers | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new PersonaPackError(`${context}.triggers must be an object.`);
  const mentions = raw.mentions;
  const keywords = raw.keywords;
  const allMessages = raw.all_messages ?? raw.allMessages;
  if (mentions !== undefined && typeof mentions !== "boolean") throw new PersonaPackError(`${context}.triggers.mentions must be a boolean.`);
  if (keywords !== undefined && (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string"))) throw new PersonaPackError(`${context}.triggers.keywords must be a string array.`);
  if (allMessages !== undefined && typeof allMessages !== "boolean") throw new PersonaPackError(`${context}.triggers.all_messages must be a boolean.`);
  return { mentions, keywords: keywords as string[] | undefined, allMessages };
}

function parseBehavioralConfig(raw: Record<string, unknown>, context: string): PersonaBehavioralConfig {
  const subscribe = raw.subscribe;
  if (subscribe !== undefined && (!Array.isArray(subscribe) || subscribe.some((s) => typeof s !== "string"))) throw new PersonaPackError(`${context}.subscribe must be a string array.`);
  // Legacy alias: `respond_to` is accepted for `triggers`, matching Buzz's own field reference.
  const triggers = parseTriggers(raw.triggers ?? raw.respond_to, context);
  const model = raw.model;
  if (model !== undefined && typeof model !== "string") throw new PersonaPackError(`${context}.model must be a string.`);
  const temperature = raw.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) throw new PersonaPackError(`${context}.temperature must be a number between 0 and 2.`);
  const maxContextTokens = raw.max_context_tokens ?? raw.maxContextTokens;
  if (maxContextTokens !== undefined && (typeof maxContextTokens !== "number" || maxContextTokens <= 0)) throw new PersonaPackError(`${context}.max_context_tokens must be a positive number.`);
  const threadReplies = raw.thread_replies ?? raw.threadReplies;
  if (threadReplies !== undefined && typeof threadReplies !== "boolean") throw new PersonaPackError(`${context}.thread_replies must be a boolean.`);
  const broadcastReplies = raw.broadcast_replies ?? raw.broadcastReplies;
  if (broadcastReplies !== undefined && typeof broadcastReplies !== "boolean") throw new PersonaPackError(`${context}.broadcast_replies must be a boolean.`);
  return {
    subscribe: subscribe as string[] | undefined, triggers, model,
    temperature: temperature as number | undefined, maxContextTokens: maxContextTokens as number | undefined,
    threadReplies: threadReplies as boolean | undefined, broadcastReplies: broadcastReplies as boolean | undefined,
  };
}

function parseMcpServers(raw: unknown, context: string): PersonaMcpServer[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new PersonaPackError(`${context}.mcp_servers must be an array.`);
  return raw.map((entry, index) => {
    if (!isRecord(entry)) throw new PersonaPackError(`${context}.mcp_servers[${index}] must be an object.`);
    const name = entry.name;
    const command = entry.command;
    if (typeof name !== "string" || !name.trim()) throw new PersonaPackError(`${context}.mcp_servers[${index}].name is required.`);
    if (typeof command !== "string" || !command.trim()) throw new PersonaPackError(`${context}.mcp_servers[${index}].command is required.`);
    const args = entry.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) throw new PersonaPackError(`${context}.mcp_servers[${index}].args must be a string array.`);
    const env = entry.env;
    if (env !== undefined && (!isRecord(env) || Object.values(env).some((v) => typeof v !== "string"))) throw new PersonaPackError(`${context}.mcp_servers[${index}].env must be a string map.`);
    return { name, command, args: args as string[] | undefined, env: env as Record<string, string> | undefined };
  });
}

/** Parses a single persona from its frontmatter object + markdown body (already split by the .persona.md parser below, or supplied directly for the inline-pack case). */
export function parsePersonaDefinition(frontmatter: unknown, promptBody: string): PersonaDefinition {
  if (!isRecord(frontmatter)) throw new PersonaPackError("Persona frontmatter must be an object.");
  const name = frontmatter.name;
  if (typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name)) throw new PersonaPackError("Persona name is required: lowercase letters, digits, hyphens, 1-64 chars.");
  const displayName = frontmatter.display_name ?? frontmatter.displayName;
  if (typeof displayName !== "string" || !displayName.trim()) throw new PersonaPackError(`Persona "${name}": display_name is required.`);
  const description = frontmatter.description;
  if (typeof description !== "string" || !description.trim()) throw new PersonaPackError(`Persona "${name}": description is required.`);
  const avatar = frontmatter.avatar;
  if (avatar !== undefined && typeof avatar !== "string") throw new PersonaPackError(`Persona "${name}": avatar must be a string.`);
  const skills = frontmatter.skills;
  if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== "string"))) throw new PersonaPackError(`Persona "${name}": skills must be a string array.`);
  if (!promptBody.trim()) throw new PersonaPackError(`Persona "${name}": prompt body must not be empty.`);
  if (promptBody.length > 32_000) throw new PersonaPackError(`Persona "${name}": prompt body must be at most 32000 characters.`);

  const behavioral = parseBehavioralConfig(frontmatter, `Persona "${name}"`);
  const mcpServers = parseMcpServers(frontmatter.mcp_servers ?? frontmatter.mcpServers, `Persona "${name}"`);

  return { name, displayName: displayName.trim(), description: description.trim(), avatar, skills: skills as string[] | undefined, mcpServers, prompt: promptBody.trim(), ...behavioral };
}

/** Splits a `.persona.md`-shaped document into its YAML frontmatter text and markdown body, per the spec's `---`-delimited format. Does not parse the YAML itself — callers pass the parsed frontmatter object (already decoded, e.g. via the `yaml` package) to parsePersonaDefinition. */
export function splitPersonaMarkdown(raw: string): { frontmatterText: string; promptBody: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new PersonaPackError("Persona document must start with a YAML frontmatter block delimited by '---'.");
  return { frontmatterText: match[1], promptBody: match[2] };
}

export function parsePersonaPackManifest(raw: unknown): PersonaPackManifest {
  if (!isRecord(raw)) throw new PersonaPackError("Pack manifest must be an object.");
  const name = raw.name;
  if (typeof name !== "string" || !name.trim()) throw new PersonaPackError("Pack name is required.");
  const version = raw.version;
  if (typeof version !== "string" || !version.trim()) throw new PersonaPackError("Pack version is required.");
  const description = raw.description;
  if (description !== undefined && typeof description !== "string") throw new PersonaPackError("Pack description must be a string.");
  const author = raw.author;
  if (author !== undefined && typeof author !== "string") throw new PersonaPackError("Pack author must be a string.");
  const defaults = raw.defaults !== undefined ? parseBehavioralConfig(isRecord(raw.defaults) ? raw.defaults : (() => { throw new PersonaPackError("Pack defaults must be an object."); })(), "Pack defaults") : undefined;

  const rawPersonas = raw.personas;
  if (!Array.isArray(rawPersonas) || rawPersonas.length === 0) throw new PersonaPackError("At least one persona is required.");
  if (rawPersonas.length > 32) throw new PersonaPackError("At most 32 personas are supported per pack.");
  const personas = rawPersonas.map((entry) => {
    if (!isRecord(entry) || typeof entry.prompt !== "string") throw new PersonaPackError("Each persona entry must be an object with a 'prompt' string field.");
    const { prompt, ...frontmatter } = entry;
    return parsePersonaDefinition(frontmatter, prompt);
  });
  const seenNames = new Set<string>();
  for (const persona of personas) {
    if (seenNames.has(persona.name)) throw new PersonaPackError(`Duplicate persona name within pack: "${persona.name}".`);
    seenNames.add(persona.name);
  }

  return { name: name.trim(), version: version.trim(), description: description?.trim(), author: author?.trim(), defaults, personas };
}

/**
 * Resolves one persona's effective behavioral config: any field the
 * persona does not explicitly set is filled from the pack's `defaults` —
 * matching the spec's example precisely (all agents default to Sonnet, one
 * persona overrides with Opus; temperature applies to all four because none
 * override it). Identity fields (name, displayName, description, prompt,
 * skills, mcpServers) are never defaulted — those are always per-persona.
 */
export function resolvePersonaConfig(pack: PersonaPackManifest, personaName: string): PersonaDefinition {
  const persona = pack.personas.find((candidate) => candidate.name === personaName);
  if (!persona) throw new PersonaPackError(`Pack "${pack.name}" has no persona named "${personaName}".`);
  const defaults = pack.defaults ?? {};
  return {
    ...persona,
    subscribe: persona.subscribe ?? defaults.subscribe,
    triggers: persona.triggers ?? defaults.triggers,
    model: persona.model ?? defaults.model,
    temperature: persona.temperature ?? defaults.temperature,
    maxContextTokens: persona.maxContextTokens ?? defaults.maxContextTokens,
    threadReplies: persona.threadReplies ?? defaults.threadReplies,
    broadcastReplies: persona.broadcastReplies ?? defaults.broadcastReplies,
  };
}
