import { test } from "node:test";
import assert from "node:assert/strict";
// Imports the built bundle, not src/agent-config.ts: tests run on Pulsar's Node
// (20.16, per .nvmrc), which can't execute TypeScript. `npm run build` emits
// lib/agent-config.js.
import {
  AGENTS_CONFIG_VERSION,
  COPILOT_AGENT_ID,
  COPILOT_AGENT_NAME,
  DEFAULT_AGENT_COMMAND,
  isLaunchedAgentStale,
  migrateAgentsConfig,
  normalizeAgentsConfig,
  resolveActiveAgent,
} from "../lib/agent-config.js";

// ---------------------------------------------------------------------------
// normalizeAgentsConfig
// ---------------------------------------------------------------------------

test("normalizeAgentsConfig: tolerates undefined and non-objects", () => {
  for (const raw of [undefined, null, 42, "x", []]) {
    const config = normalizeAgentsConfig(raw);
    assert.deepEqual(config.agents, {});
    assert.equal(config.version, 0);
    assert.equal(config.activeAgentId, undefined);
  }
});

test("normalizeAgentsConfig: drops invalid agent entries", () => {
  const config = normalizeAgentsConfig({
    agents: {
      good: { name: "Good", command: "good --acp" },
      noCommand: { name: "No command" },
      emptyCommand: { name: "Empty", command: "   " },
      notObject: "nope",
    },
  });
  assert.deepEqual(Object.keys(config.agents), ["good"]);
  assert.deepEqual(config.agents.good, { name: "Good", command: "good --acp" });
});

test("normalizeAgentsConfig: defaults a missing name to the id", () => {
  const config = normalizeAgentsConfig({
    agents: { foo: { command: "foo --acp" } },
  });
  assert.equal(config.agents.foo.name, "foo");
});

test("normalizeAgentsConfig: preserves unknown top-level and per-agent fields", () => {
  const config = normalizeAgentsConfig({
    version: 1,
    future: "keep-me",
    agents: { foo: { name: "Foo", command: "foo", env: { A: "1" } } },
  });
  assert.equal(config.future, "keep-me");
  assert.deepEqual(config.agents.foo.env, { A: "1" });
});

test("normalizeAgentsConfig: drops an empty activeAgentId", () => {
  assert.equal(normalizeAgentsConfig({ activeAgentId: "  " }).activeAgentId, undefined);
});

// ---------------------------------------------------------------------------
// migrateAgentsConfig (seeding)
// ---------------------------------------------------------------------------

test("migrateAgentsConfig: seeds the copilot default when unmigrated and empty", () => {
  const { config, changed } = migrateAgentsConfig(undefined);
  assert.equal(changed, true);
  assert.equal(config.version, AGENTS_CONFIG_VERSION);
  assert.equal(config.activeAgentId, COPILOT_AGENT_ID);
  assert.deepEqual(config.agents[COPILOT_AGENT_ID], {
    name: COPILOT_AGENT_NAME,
    command: DEFAULT_AGENT_COMMAND,
  });
});

test("migrateAgentsConfig: legacy copilot command keeps the canonical identity", () => {
  const { config } = migrateAgentsConfig(undefined, DEFAULT_AGENT_COMMAND);
  assert.deepEqual(Object.keys(config.agents), [COPILOT_AGENT_ID]);
  assert.equal(config.agents[COPILOT_AGENT_ID].name, COPILOT_AGENT_NAME);
});

test("migrateAgentsConfig: derives id/name from an arbitrary legacy command", () => {
  const { config } = migrateAgentsConfig(undefined, "gemini --experimental-acp");
  assert.deepEqual(Object.keys(config.agents), ["gemini"]);
  assert.equal(config.agents.gemini.name, "gemini");
  assert.equal(config.agents.gemini.command, "gemini --experimental-acp");
  assert.equal(config.activeAgentId, "gemini");
});

test("migrateAgentsConfig: derives id/name from a quoted path command", () => {
  const { config } = migrateAgentsConfig(undefined, '"C:\\tools\\my agent.cmd" --acp');
  const ids = Object.keys(config.agents);
  assert.equal(ids.length, 1);
  assert.equal(config.agents[ids[0]].name, "my agent");
  assert.equal(ids[0], "my-agent");
});

test("migrateAgentsConfig: precedence — existing agents beat legacy and default", () => {
  const { config } = migrateAgentsConfig(
    { agents: { custom: { name: "Custom", command: "custom --acp" } } },
    "gemini --experimental-acp",
  );
  assert.deepEqual(Object.keys(config.agents), ["custom"]);
  assert.equal(config.version, AGENTS_CONFIG_VERSION);
  assert.equal(config.activeAgentId, "custom");
});

test("migrateAgentsConfig: preserves a valid existing activeAgentId", () => {
  const { config } = migrateAgentsConfig({
    activeAgentId: "b",
    agents: {
      a: { name: "A", command: "a" },
      b: { name: "B", command: "b" },
    },
  });
  assert.equal(config.activeAgentId, "b");
});

// ---------------------------------------------------------------------------
// migrateAgentsConfig (idempotency / version gating)
// ---------------------------------------------------------------------------

test("migrateAgentsConfig: is idempotent once migrated", () => {
  const first = migrateAgentsConfig(undefined).config;
  const second = migrateAgentsConfig(first);
  assert.equal(second.changed, false);
  assert.deepEqual(second.config, first);
});

test("migrateAgentsConfig: respects an intentionally empty migrated registry", () => {
  const { config, changed } = migrateAgentsConfig({ version: 1, agents: {} });
  assert.equal(changed, false);
  assert.deepEqual(config.agents, {});
  assert.equal(config.activeAgentId, undefined);
});

test("migrateAgentsConfig: does not auto-correct an invalid activeAgentId once migrated", () => {
  const { config, changed } = migrateAgentsConfig({
    version: 1,
    activeAgentId: "gone",
    agents: { a: { name: "A", command: "a" } },
  });
  assert.equal(changed, false);
  assert.equal(config.activeAgentId, "gone");
});

test("migrateAgentsConfig: future version is non-destructive (no write-back)", () => {
  const { config, changed } = migrateAgentsConfig({
    version: 99,
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" }, bad: { name: "Bad" } },
  });
  assert.equal(changed, false);
  assert.equal(config.version, 99);
  // Still normalized in memory (invalid entry dropped) but not persisted.
  assert.deepEqual(Object.keys(config.agents), ["a"]);
});

// ---------------------------------------------------------------------------
// resolveActiveAgent (STRICT)
// ---------------------------------------------------------------------------

test("resolveActiveAgent: ok when activeAgentId is set and present", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "a",
    agents: { a: { name: "A", command: "a" } },
  });
  const resolved = resolveActiveAgent(config);
  assert.equal(resolved.reason, "ok");
  assert.equal(resolved.id, "a");
  assert.equal(resolved.agent.command, "a");
});

test("resolveActiveAgent: no-agents when registry is empty", () => {
  assert.equal(resolveActiveAgent(normalizeAgentsConfig({})).reason, "no-agents");
});

test("resolveActiveAgent: STRICT — never falls back to the first agent", () => {
  const config = normalizeAgentsConfig({
    agents: {
      a: { name: "A", command: "a" },
      b: { name: "B", command: "b" },
    },
  });
  const resolved = resolveActiveAgent(config);
  assert.equal(resolved.reason, "unset-or-invalid");
  assert.equal(resolved.agent, undefined);
  assert.equal(resolved.id, undefined);
});

test("resolveActiveAgent: unset-or-invalid when activeAgentId points nowhere", () => {
  const config = normalizeAgentsConfig({
    activeAgentId: "gone",
    agents: { a: { name: "A", command: "a" } },
  });
  assert.equal(resolveActiveAgent(config).reason, "unset-or-invalid");
});

// ---------------------------------------------------------------------------
// isLaunchedAgentStale
// ---------------------------------------------------------------------------

test("isLaunchedAgentStale: true when the launched id is gone", () => {
  const config = normalizeAgentsConfig({ agents: { a: { name: "A", command: "a" } } });
  assert.equal(isLaunchedAgentStale(config, "b"), true);
});

test("isLaunchedAgentStale: false when the launched id is still present", () => {
  const config = normalizeAgentsConfig({ agents: { a: { name: "A", command: "a" } } });
  assert.equal(isLaunchedAgentStale(config, "a"), false);
});

test("isLaunchedAgentStale: false when no agent is launched", () => {
  const config = normalizeAgentsConfig({ agents: {} });
  assert.equal(isLaunchedAgentStale(config, null), false);
  assert.equal(isLaunchedAgentStale(config, undefined), false);
});
