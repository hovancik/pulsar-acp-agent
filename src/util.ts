import { ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import spawn from "cross-spawn";
import * as acp from "@agentclientprotocol/sdk";

export const TERMINAL_KILL_GRACE_MS = 2_000;

// Splits a command line into argv, honoring double-quoted spans so that
// executable paths containing spaces can be quoted. Backslashes are literal
// (Windows paths), and no shell metacharacters are interpreted.
export function parseCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && (char === " " || char === "\t" || char === "\r" || char === "\n")) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// A 1-based, inclusive line range within a file. Callers convert from Atom's
// 0-based, end-exclusive buffer ranges via `selectionLineRange` so this module
// stays editor-agnostic.
export type LineRange = { start: number; end: number };

// A 0-based, end-exclusive buffer range, shaped like Atom's `getBufferRange()`
// result but with plain numbers so it can be tested without `atom`.
export type BufferRange = {
  start: { row: number; column: number };
  end: { row: number; column: number };
};

// Converts a 0-based, end-exclusive buffer range to a 1-based, inclusive line
// range for a URI fragment, or null when the range is empty. A selection ending
// at column 0 of a later line covers whole lines, so the trailing empty line is
// dropped (e.g. [3,0]-[4,0] is line 4 only, not lines 4-5).
export function selectionLineRange(range: BufferRange): LineRange | null {
  if (
    range.start.row === range.end.row &&
    range.start.column === range.end.column
  ) {
    return null;
  }
  const start = range.start.row + 1;
  const end =
    range.end.column === 0 && range.end.row > range.start.row
      ? range.end.row
      : range.end.row + 1;
  return { start, end };
}

// Builds a `file://` URI for an absolute path, optionally appending a 1-based
// inclusive line-range fragment (`L5` for one line, `L5:9` for a span). The
// fragment is appended to the already-encoded href as plain text; the `#` is
// never passed through `pathToFileURL`, which would percent-encode it.
export function fileUri(absolutePath: string, range?: LineRange): string {
  const href = pathToFileURL(absolutePath).href;
  if (!range) return href;
  const fragment =
    range.end > range.start ? `L${range.start}:${range.end}` : `L${range.start}`;
  return `${href}#${fragment}`;
}

// A materialized piece of editor context, ready to inline into a prompt.
export type ContextAttachment = { uri: string; text: string };

// Assembles an ACP embedded-resource content block for attached editor context.
// The text is inlined (so unsaved edits and out-of-tree files work without the
// agent re-reading), and `mimeType` is omitted to match Zed. Capability gating
// on `promptCapabilities.embeddedContext` is the caller's responsibility.
export function buildContextBlock(attachment: ContextAttachment): acp.ContentBlock {
  return {
    type: "resource",
    resource: { uri: attachment.uri, text: attachment.text },
  };
}

// Config-option choices may arrive flat or grouped; flatten to one ordered list.
export function flattenConfigSelectOptions(
  options: acp.SessionConfigSelectOptions,
): acp.SessionConfigSelectOption[] {
  return (
    options as Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup>
  ).flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

// Resolves a select option's current value to its display name, falling back to
// the raw value id when the value isn't present in the option list.
export function configOptionLabel(option: acp.SessionConfigSelect): string {
  const match = flattenConfigSelectOptions(option.options).find(
    (choice) => choice.value === option.currentValue,
  );
  return match?.name || option.currentValue;
}

// Classifies the auth methods an agent advertises into the action the client
// should take when `session/new` reports authentication is required. Only
// `agent`-type methods are actionable: the client calls `authenticate` and the
// agent drives its own flow. The experimental `env_var` and `terminal` variants
// carry a `type` discriminator (per the ACP schema, an absent `type` means
// `agent`) and need client-side handling this package does not advertise, so
// they are ignored. `none` means the agent requires auth but offers nothing
// this client can drive; `auto` authenticates silently; `pick` prompts the user.
export type AuthMethodClassification =
  | { kind: "none" }
  | { kind: "auto"; method: acp.AuthMethodAgent }
  | { kind: "pick"; methods: acp.AuthMethodAgent[] };

export function classifyAuthMethods(
  methods: acp.AuthMethod[],
): AuthMethodClassification {
  const agentMethods = methods.filter(
    (method): method is acp.AuthMethodAgent => !("type" in method),
  );
  if (agentMethods.length === 0) return { kind: "none" };
  if (agentMethods.length === 1) return { kind: "auto", method: agentMethods[0] };
  return { kind: "pick", methods: agentMethods };
}

export type PlanLifecycleEntry = { status: acp.PlanEntryStatus };

export function completedPlanEntries<T extends PlanLifecycleEntry>(
  entries: T[],
): boolean {
  return entries.length > 0 && entries.every((entry) => entry.status === "completed");
}

export function nextTurnActivePlanEntries<T extends PlanLifecycleEntry>(
  entries: T[],
): T[] {
  return entries.filter((entry) => entry.status !== "completed");
}

export type InfoRow = { key: string; value: string };

export function flattenInfoRows(value: unknown): InfoRow[] {
  const rows: InfoRow[] = [];
  const visit = (current: unknown, path: string[]): void => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const entries = Object.entries(current);
      if (entries.length === 0) {
        if (path.length > 0) rows.push({ key: path.join("."), value: "{}" });
        return;
      }
      for (const [key, child] of entries) visit(child, path.concat(key));
      return;
    }
    rows.push({ key: path.join(".") || "value", value: formatInfoValue(current) });
  };
  visit(value, []);
  return rows;
}

function formatInfoValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return String(value);
  return JSON.stringify(value) ?? String(value);
}

// Holds a spawned terminal process plus its ring-buffered output. Output is a
// single merged stdout+stderr buffer truncated from the beginning (oldest
// dropped) once it exceeds the byte limit, kept at a UTF-8 + line boundary.
export class TerminalRecord {
  truncated = false;
  exitStatus: acp.TerminalExitStatus | null = null;
  private chunkList: Buffer[] = [];
  private totalLength = 0;
  private waitResolvers = new Set<(status: acp.TerminalExitStatus) => void>();
  private emitScheduled = false;

  constructor(
    readonly child: ChildProcess | null,
    private readonly outputByteLimit: number,
    private readonly onOutput: () => void,
  ) {}

  append(chunk: Buffer): void {
    this.chunkList.push(chunk);
    this.totalLength += chunk.length;

    if (this.totalLength > this.outputByteLimit) {
      let combined = Buffer.concat(this.chunkList);
      let start = combined.length - this.outputByteLimit;
      while (start < combined.length && (combined[start] & 0xc0) === 0x80) {
        start++;
      }
      const newline = combined.indexOf(0x0a, start);
      if (newline !== -1 && newline + 1 < combined.length) {
        start = newline + 1;
      }
      this.chunkList = [combined.subarray(start)];
      this.totalLength = this.chunkList[0].length;
      this.truncated = true;
    }
    this.scheduleEmit();
  }

  // Coalesce UI emits: a chatty command produces thousands of small chunks, and
  // re-rendering the full buffer on each one causes jank. Pull-based
  // `terminal/output` still reads `output()` directly, so it stays current.
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setTimeout(() => {
      this.emitScheduled = false;
      this.onOutput();
    }, 33);
  }

  flushOutput(): void {
    this.onOutput();
  }

  output(): string {
    if (this.chunkList.length > 1) {
      this.chunkList = [Buffer.concat(this.chunkList)];
    }
    return this.chunkList.length > 0 ? this.chunkList[0].toString("utf8") : "";
  }

  resolveExit(status: acp.TerminalExitStatus): void {
    if (!this.exitStatus) this.exitStatus = status;
    this.releaseWaiters();
  }

  // Unblocks pending `waitForExit` callers without recording a synthetic exit
  // status, so the kill-escalation timer in `killProcess` can still fire when a
  // terminal is released while its process is still being torn down.
  releaseWaiters(): void {
    const status = this.exitStatus ?? { exitCode: null, signal: null };
    for (const resolve of this.waitResolvers) resolve(status);
    this.waitResolvers.clear();
  }

  waitForExit(): Promise<acp.TerminalExitStatus> {
    if (this.exitStatus) return Promise.resolve(this.exitStatus);
    return new Promise((resolve) => this.waitResolvers.add(resolve));
  }

  // SIGTERM, then SIGKILL after a grace period. On POSIX the child is spawned
  // detached so the whole process group can be signalled; on Windows use
  // `taskkill /t` to terminate the whole process tree (graceful, then forced),
  // since `child.kill()` would only terminate the root and orphan descendants.
  killProcess(): void {
    const pid = this.child?.pid;
    if (pid == null || this.exitStatus) return;
    if (process.platform === "win32") {
      this.runTaskkill(pid, false);
      setTimeout(() => {
        if (this.exitStatus) return;
        this.runTaskkill(pid, true);
      }, TERMINAL_KILL_GRACE_MS);
      return;
    }
    this.signalGroup(pid, "SIGTERM");
    setTimeout(() => {
      if (this.exitStatus) return;
      this.signalGroup(pid, "SIGKILL");
    }, TERMINAL_KILL_GRACE_MS);
  }

  private runTaskkill(pid: number, force: boolean): void {
    const args = ["/pid", String(pid), "/t"];
    if (force) args.push("/f");
    try {
      const killer = spawn("taskkill", args, { windowsHide: true });
      killer.on("error", () => {});
    } catch {}
  }

  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child?.kill(signal);
      } catch {}
    }
  }
}
