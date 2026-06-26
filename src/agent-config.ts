import * as path from "path";
import { parseCommandLine } from "./util";

// Pure agent-registry logic. NO `atom` import so it can be unit-tested via the
// built lib/agent-config.js (like util.ts). All atom.config glue lives at the
// call sites and delegates here.

export interface Agent {
  name: string;
  command: string;
}

export interface AgentsConfig {
  version: number;
  activeAgentId?: string;
  agents: Record<string, Agent>;
}

export type ResolveReason = "ok" | "no-agents" | "unset-or-invalid";

export const AGENTS_CONFIG_VERSION = 1;
export const DEFAULT_AGENT_COMMAND = "copilot --acp --stdio";
export const COPILOT_AGENT_ID = "copilot";
export const COPILOT_AGENT_NAME = "GitHub Copilot";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => key in b && deepEqual(a[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

// Lowercase, collapse non-alphanumerics to single dashes, trim dashes.
function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Choose a stable id/name when seeding from a legacy command string. The known
// Copilot default keeps its canonical identity; anything else derives from the
// executable basename so an arbitrary command is never mislabeled as Copilot.
function seedAgentFromCommand(command: string): { id: string; name: string } {
  if (command.trim() === DEFAULT_AGENT_COMMAND) {
    return { id: COPILOT_AGENT_ID, name: COPILOT_AGENT_NAME };
  }
  const argv = parseCommandLine(command);
  const exe = argv[0] ?? command;
  // path.win32 splits both `/` and `\` on every host (path.parse wouldn't).
  const base = path.win32.parse(exe).name || exe;
  const id = sanitizeId(base) || "agent";
  return { id, name: base || id };
}

// Defensive coercion: tolerate undefined/non-object/garbage, drop invalid
// agent entries (require a usable `command`), and preserve unknown top-level
// and per-agent fields for forward compatibility.
export function normalizeAgentsConfig(raw: unknown): AgentsConfig {
  const source = isObject(raw) ? raw : {};

  const agents: Record<string, Agent> = {};
  const rawAgents = isObject(source.agents) ? source.agents : {};
  for (const [id, entry] of Object.entries(rawAgents)) {
    if (!id || !isObject(entry)) continue;
    const command = entry.command;
    if (typeof command !== "string" || command.trim() === "") continue;
    const name =
      typeof entry.name === "string" && entry.name.trim() !== ""
        ? entry.name
        : id;
    agents[id] = { ...(entry as Record<string, unknown>), name, command } as Agent;
  }

  const version =
    typeof source.version === "number" && Number.isFinite(source.version)
      ? source.version
      : 0;

  const config = { ...source, version, agents } as AgentsConfig;

  if (
    typeof source.activeAgentId === "string" &&
    source.activeAgentId.trim() !== ""
  ) {
    config.activeAgentId = source.activeAgentId;
  } else {
    delete config.activeAgentId;
  }

  return config;
}

// Idempotent, version-gated migration/seed. Returns the resulting config and
// whether it changed (so callers only persist on change). `version` is the
// migration marker: its absence means "unmigrated → seed"; a present version
// with empty agents is an intentional empty state and is respected.
export function migrateAgentsConfig(
  raw: unknown,
  legacyCommand?: string,
): { config: AgentsConfig; changed: boolean } {
  const hadVersion =
    isObject(raw) &&
    typeof raw.version === "number" &&
    Number.isFinite(raw.version);
  const normalized = normalizeAgentsConfig(raw);

  if (hadVersion) {
    // Already migrated. Respect empty agents and never auto-correct an invalid
    // activeAgentId (idle re-resolves at runtime). For a future version, stay
    // non-destructive: use the cleaned shape in memory but do not persist.
    const changed =
      normalized.version <= AGENTS_CONFIG_VERSION &&
      !deepEqual(raw, normalized);
    return { config: normalized, changed };
  }

  // Unmigrated. Seed precedence: existing valid agents → legacy command →
  // copilot default.
  const config: AgentsConfig = { ...normalized, version: AGENTS_CONFIG_VERSION };
  const ids = Object.keys(config.agents);

  if (ids.length > 0) {
    // Preserve hand-written agents; only stamp version and ensure a selection.
    if (!config.activeAgentId || !config.agents[config.activeAgentId]) {
      config.activeAgentId = ids[0];
    }
    return { config, changed: true };
  }

  const command =
    typeof legacyCommand === "string" && legacyCommand.trim() !== ""
      ? legacyCommand.trim()
      : DEFAULT_AGENT_COMMAND;
  const seed = seedAgentFromCommand(command);
  config.agents = { [seed.id]: { name: seed.name, command } };
  config.activeAgentId = seed.id;
  return { config, changed: true };
}

// STRICT launch resolution: only resolves when activeAgentId is set AND present
// in agents. No "first" fallback — launching is never a guess. A default is
// chosen only by migration (a one-time persisted write).
export function resolveActiveAgent(config: AgentsConfig): {
  agent?: Agent;
  id?: string;
  reason: ResolveReason;
} {
  if (Object.keys(config.agents).length === 0) {
    return { reason: "no-agents" };
  }
  const id = config.activeAgentId;
  if (id && config.agents[id]) {
    return { agent: config.agents[id], id, reason: "ok" };
  }
  return { reason: "unset-or-invalid" };
}

// True when the running agent's id is no longer present in the registry.
export function isLaunchedAgentStale(
  config: AgentsConfig,
  launchedSnapshotId: string | null | undefined,
): boolean {
  if (!launchedSnapshotId) return false;
  return !config.agents[launchedSnapshotId];
}
