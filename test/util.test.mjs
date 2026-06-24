import { test } from "node:test";
import assert from "node:assert/strict";
// Imports the built bundle, not src/util.ts: tests run on Pulsar's Node (20.16,
// per .nvmrc), which can't execute TypeScript. `npm run build` emits lib/util.js.
import { flattenInfoRows, modeLabel, parseCommandLine, TerminalRecord } from "../lib/util.js";

// ---------------------------------------------------------------------------
// parseCommandLine
// ---------------------------------------------------------------------------

test("parseCommandLine: splits basic command", () => {
  assert.deepEqual(parseCommandLine("copilot --acp --stdio"), [
    "copilot",
    "--acp",
    "--stdio",
  ]);
});

test("parseCommandLine: quoted path with spaces", () => {
  assert.deepEqual(
    parseCommandLine('"C:\\Program Files\\agent.exe" --acp --stdio'),
    ["C:\\Program Files\\agent.exe", "--acp", "--stdio"],
  );
});

test("parseCommandLine: empty string", () => {
  assert.deepEqual(parseCommandLine(""), []);
});

test("parseCommandLine: whitespace only", () => {
  assert.deepEqual(parseCommandLine("   \t\n"), []);
});

// ---------------------------------------------------------------------------
// TerminalRecord truncation
// ---------------------------------------------------------------------------

test("TerminalRecord: no truncation under limit", () => {
  const record = new TerminalRecord(null, 100, () => {});
  record.append(Buffer.from("hello\nworld\n"));
  assert.equal(record.output(), "hello\nworld\n");
  assert.equal(record.truncated, false);
});

test("TerminalRecord: truncates at line boundary", () => {
  // "line1\nline2\nline3\n" (18 bytes) + "XXXXXXXXXX" (10 bytes) = 28 bytes > limit 20
  // naive cut is at byte 8 (mid-"line2"); code advances to the '\n' at byte 11,
  // so output starts at byte 12 = "line3\nXXXXXXXXXX"
  const record = new TerminalRecord(null, 20, () => {});
  record.append(Buffer.from("line1\nline2\nline3\n"));
  record.append(Buffer.from("XXXXXXXXXX"));
  assert.equal(record.output(), "line3\nXXXXXXXXXX");
  assert.equal(record.truncated, true);
});

test("TerminalRecord: does not split a UTF-8 multibyte character", () => {
  // "a\né\n" = [0x61,0x0a,0xc3,0xa9,0x0a] (5 bytes) + "bc" (2 bytes) = 7 bytes > limit 4
  // naive cut at byte 3 lands on 0xa9, a continuation byte; code advances to
  // byte 4 ('\n'), then snaps to byte 5, so output = "bc"
  const record = new TerminalRecord(null, 4, () => {});
  record.append(Buffer.from("a\n\u00e9\n")); // é is U+00E9, encoded as 0xC3 0xA9
  record.append(Buffer.from("bc"));
  assert.equal(record.output(), "bc");
  assert.equal(record.truncated, true);
});

// ---------------------------------------------------------------------------
// parseCommandLine: quoting and security
// ---------------------------------------------------------------------------

test("parseCommandLine: keeps a quoted span with spaces as one argument", () => {
  assert.deepEqual(parseCommandLine('git commit -m "a b c"'), [
    "git",
    "commit",
    "-m",
    "a b c",
  ]);
});

test("parseCommandLine: merges adjacent quoted and unquoted text", () => {
  assert.deepEqual(parseCommandLine('a"b c"d'), ["ab cd"]);
});

test("parseCommandLine: an unterminated quote consumes the rest of the line", () => {
  assert.deepEqual(parseCommandLine('--msg "unterminated'), [
    "--msg",
    "unterminated",
  ]);
});

// Security: the command line is split into argv only — no shell is involved —
// so metacharacters ($(), &&, |, ;) must survive as inert literal tokens and
// can never trigger expansion or command injection downstream.
test("parseCommandLine: does not interpret shell metacharacters", () => {
  assert.deepEqual(parseCommandLine("echo $(whoami) && rm -rf / | cat ; id"), [
    "echo",
    "$(whoami)",
    "&&",
    "rm",
    "-rf",
    "/",
    "|",
    "cat",
    ";",
    "id",
  ]);
});

// ---------------------------------------------------------------------------
// modeLabel
// ---------------------------------------------------------------------------

test("modeLabel: resolves a known mode id to its name", () => {
  const state = {
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "code", name: "Code" },
    ],
    currentModeId: "ask",
  };
  assert.equal(modeLabel(state, "code"), "Code");
});

test("modeLabel: falls back to the id for an unknown mode", () => {
  const state = { availableModes: [{ id: "ask", name: "Ask" }], currentModeId: "ask" };
  assert.equal(modeLabel(state, "https://example/#x"), "https://example/#x");
});

test("modeLabel: falls back to the id when state is null", () => {
  assert.equal(modeLabel(null, "code"), "code");
});

// ---------------------------------------------------------------------------
// flattenInfoRows
// ---------------------------------------------------------------------------

test("flattenInfoRows: flattens nested values and object-presence leaves", () => {
  assert.deepEqual(
    flattenInfoRows({
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      positionEncoding: "utf-8",
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      sessionCapabilities: { list: {} },
    }),
    [
      { key: "loadSession", value: "true" },
      { key: "mcpCapabilities.http", value: "true" },
      { key: "mcpCapabilities.sse", value: "true" },
      { key: "positionEncoding", value: "utf-8" },
      { key: "promptCapabilities.image", value: "true" },
      { key: "promptCapabilities.audio", value: "false" },
      { key: "promptCapabilities.embeddedContext", value: "true" },
      { key: "sessionCapabilities.list", value: "{}" },
    ],
  );
});

// ---------------------------------------------------------------------------
// TerminalRecord exit lifecycle
// ---------------------------------------------------------------------------
// `child` is untouched by the buffer/exit logic (only killProcess uses it), so
// these tests pass null rather than spawning a real process.

test("TerminalRecord: resolveExit records status and unblocks waiters", async () => {
  const record = new TerminalRecord(null, 100, () => {});
  const pending = record.waitForExit();
  record.resolveExit({ exitCode: 0, signal: null });
  assert.deepEqual(record.exitStatus, { exitCode: 0, signal: null });
  assert.deepEqual(await pending, { exitCode: 0, signal: null });
});

test("TerminalRecord: waitForExit resolves immediately after exit", async () => {
  const record = new TerminalRecord(null, 100, () => {});
  record.resolveExit({ exitCode: 3, signal: null });
  assert.deepEqual(await record.waitForExit(), { exitCode: 3, signal: null });
});

test("TerminalRecord: the first exit status wins", () => {
  const record = new TerminalRecord(null, 100, () => {});
  record.resolveExit({ exitCode: 0, signal: null });
  record.resolveExit({ exitCode: 1, signal: "SIGKILL" });
  assert.deepEqual(record.exitStatus, { exitCode: 0, signal: null });
});
