/**
 * Persona packs — Buzz-parity (crates/buzz-persona) — schema/resolver tests.
 * Covers the field reference table from PERSONA_PACK_SPEC.md and the
 * defaults-merge example given verbatim in the spec (four agents default to
 * Sonnet, one overrides with Opus, temperature applies to all four).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePersonaPackManifest,
  parsePersonaDefinition,
  splitPersonaMarkdown,
  resolvePersonaConfig,
  PersonaPackError,
} from "../src/lib/mission/persona-pack-schema.ts";

function minimalPersona(overrides: Record<string, unknown> = {}) {
  return { name: "lep", display_name: "Lep", description: "Security reviewer", prompt: "You are Lep.", ...overrides };
}

test("parses a minimal pack with one persona", () => {
  const pack = parsePersonaPackManifest({ name: "Meadow Security Team", version: "1.2.0", personas: [minimalPersona()] });
  assert.equal(pack.name, "Meadow Security Team");
  assert.equal(pack.personas.length, 1);
  assert.equal(pack.personas[0].name, "lep");
  assert.equal(pack.personas[0].prompt, "You are Lep.");
});

test("rejects a pack with no name, version, or personas", () => {
  assert.throws(() => parsePersonaPackManifest({ version: "1.0.0", personas: [minimalPersona()] }), PersonaPackError);
  assert.throws(() => parsePersonaPackManifest({ name: "x", personas: [minimalPersona()] }), PersonaPackError);
  assert.throws(() => parsePersonaPackManifest({ name: "x", version: "1.0.0", personas: [] }), PersonaPackError);
});

test("rejects duplicate persona names within a pack", () => {
  assert.throws(() => parsePersonaPackManifest({
    name: "x", version: "1.0.0",
    personas: [minimalPersona(), minimalPersona({ description: "Another one" })],
  }), PersonaPackError);
});

test("rejects an invalid persona name (not lowercase-kebab)", () => {
  assert.throws(() => parsePersonaDefinition({ name: "Lep!", display_name: "Lep", description: "x" }, "prompt"), PersonaPackError);
});

test("rejects a persona with no prompt body", () => {
  assert.throws(() => parsePersonaDefinition({ name: "lep", display_name: "Lep", description: "x" }, ""), PersonaPackError);
  assert.throws(() => parsePersonaDefinition({ name: "lep", display_name: "Lep", description: "x" }, "   "), PersonaPackError);
});

test("accepts the legacy respond_to alias for triggers", () => {
  const persona = parsePersonaDefinition({ name: "lep", display_name: "Lep", description: "x", respond_to: { mentions: true, keywords: ["security"] } }, "prompt");
  assert.deepEqual(persona.triggers, { mentions: true, keywords: ["security"], allMessages: undefined });
});

test("rejects an out-of-range temperature", () => {
  assert.throws(() => parsePersonaDefinition({ name: "lep", display_name: "Lep", description: "x", temperature: 3.5 }, "prompt"), PersonaPackError);
});

test("parses mcp_servers with args and env", () => {
  const persona = parsePersonaDefinition({
    name: "lep", display_name: "Lep", description: "x",
    mcp_servers: [{ name: "semgrep", command: "semgrep-mcp", args: ["--stdio"], env: { SEMGREP_TOKEN: "${SEMGREP_TOKEN}" } }],
  }, "prompt");
  assert.equal(persona.mcpServers?.[0].name, "semgrep");
  assert.deepEqual(persona.mcpServers?.[0].args, ["--stdio"]);
});

test("splitPersonaMarkdown splits frontmatter from the prompt body", () => {
  const doc = `---\nname: "lep"\ndisplay_name: "Lep"\n---\n\nYou are Lep, a security-focused code reviewer.\n`;
  const { frontmatterText, promptBody } = splitPersonaMarkdown(doc);
  assert.match(frontmatterText, /name: "lep"/);
  assert.equal(promptBody.trim(), "You are Lep, a security-focused code reviewer.");
});

test("splitPersonaMarkdown rejects a document with no frontmatter block", () => {
  assert.throws(() => splitPersonaMarkdown("You are Lep.\n"), PersonaPackError);
});

test("resolvePersonaConfig: spec example — defaults apply except where a persona overrides", () => {
  // Verbatim scenario from PERSONA_PACK_SPEC.md section 2: four agents
  // default to Sonnet; pip overrides with Opus; temperature 0.7 applies to
  // all four because none override it.
  const pack = parsePersonaPackManifest({
    name: "Meadow Security Team",
    version: "1.2.0",
    defaults: { model: "anthropic:claude-sonnet-4-20250514", temperature: 0.7 },
    personas: [
      { name: "pip", display_name: "Pip", description: "Lead", prompt: "You are Pip.", model: "anthropic:claude-4-opus-20250514", subscribe: ["#security-reviews"] },
      { name: "lep", display_name: "Lep", description: "Reviewer", prompt: "You are Lep." },
      { name: "thistle", display_name: "Thistle", description: "Reviewer", prompt: "You are Thistle." },
      { name: "berry", display_name: "Berry", description: "Reviewer", prompt: "You are Berry." },
    ],
  });

  const pip = resolvePersonaConfig(pack, "pip");
  assert.equal(pip.model, "anthropic:claude-4-opus-20250514");
  assert.equal(pip.temperature, 0.7);
  assert.deepEqual(pip.subscribe, ["#security-reviews"]);

  const lep = resolvePersonaConfig(pack, "lep");
  assert.equal(lep.model, "anthropic:claude-sonnet-4-20250514");
  assert.equal(lep.temperature, 0.7);

  const berry = resolvePersonaConfig(pack, "berry");
  assert.equal(berry.model, "anthropic:claude-sonnet-4-20250514");
});

test("resolvePersonaConfig throws for an unknown persona name", () => {
  const pack = parsePersonaPackManifest({ name: "x", version: "1.0.0", personas: [minimalPersona()] });
  assert.throws(() => resolvePersonaConfig(pack, "does-not-exist"), PersonaPackError);
});

test("resolvePersonaConfig never defaults identity fields (name, prompt, description)", () => {
  const pack = parsePersonaPackManifest({
    name: "x", version: "1.0.0",
    defaults: { model: "shared-model" },
    personas: [minimalPersona()],
  });
  const resolved = resolvePersonaConfig(pack, "lep");
  assert.equal(resolved.prompt, "You are Lep.");
  assert.equal(resolved.description, "Security reviewer");
});
