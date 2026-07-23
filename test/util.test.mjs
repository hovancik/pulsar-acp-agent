import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Imports the built bundle, not src/util.ts: tests run on Pulsar's Node (20.16,
// per .nvmrc), which can't execute TypeScript. `npm run build` emits lib/util.js.
import {
  buildContextBlock,
  classifyAuthMethods,
  completedPlanEntries,
  configOptionLabel,
  fileUri,
  flattenConfigSelectOptions,
  flattenInfoRows,
  nextTurnActivePlanEntries,
  parseCommandLine,
  selectionLineRange,
  TerminalRecord,
} from "../lib/util.js";

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
// configOptionLabel / flattenConfigSelectOptions
// ---------------------------------------------------------------------------

test("configOptionLabel: resolves the current value to its name", () => {
  const option = {
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5" },
      { value: "opus", name: "Claude Opus" },
    ],
  };
  assert.equal(configOptionLabel(option), "GPT-5");
});

test("configOptionLabel: resolves a value inside a group", () => {
  const option = {
    currentValue: "acp-helper",
    options: [
      {
        group: "custom",
        name: "Custom",
        options: [{ value: "acp-helper", name: "ACP Helper" }],
      },
    ],
  };
  assert.equal(configOptionLabel(option), "ACP Helper");
});

test("configOptionLabel: falls back to the value id when not found", () => {
  const option = { currentValue: "unknown", options: [{ value: "x", name: "X" }] };
  assert.equal(configOptionLabel(option), "unknown");
});

test("flattenConfigSelectOptions: flattens groups into a single list", () => {
  const grouped = [
    { group: "a", name: "A", options: [{ value: "1", name: "One" }] },
    { group: "b", name: "B", options: [{ value: "2", name: "Two" }] },
  ];
  assert.deepEqual(flattenConfigSelectOptions(grouped), [
    { value: "1", name: "One" },
    { value: "2", name: "Two" },
  ]);
});

// ---------------------------------------------------------------------------
// ACP plan lifecycle helpers
// ---------------------------------------------------------------------------

test("completedPlanEntries: only true for a non-empty fully completed plan", () => {
  assert.equal(completedPlanEntries([]), false);
  assert.equal(
    completedPlanEntries([
      { content: "A", priority: "high", status: "completed" },
      { content: "B", priority: "medium", status: "completed" },
    ]),
    true,
  );
  assert.equal(
    completedPlanEntries([
      { content: "A", priority: "high", status: "completed" },
      { content: "B", priority: "medium", status: "in_progress" },
    ]),
    false,
  );
});

test("nextTurnActivePlanEntries: drops completed entries and keeps interrupted work", () => {
  const pending = { content: "A", priority: "high", status: "pending" };
  const inProgress = {
    content: "B",
    priority: "medium",
    status: "in_progress",
  };
  const completed = { content: "C", priority: "low", status: "completed" };

  assert.deepEqual(
    nextTurnActivePlanEntries([completed, pending, inProgress]),
    [pending, inProgress],
  );
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

// ---------------------------------------------------------------------------
// selectionLineRange (0-based exclusive buffer range -> 1-based inclusive lines)
// ---------------------------------------------------------------------------

test("selectionLineRange: single-line selection", () => {
  assert.deepEqual(
    selectionLineRange({ start: { row: 3, column: 2 }, end: { row: 3, column: 8 } }),
    { start: 4, end: 4 },
  );
});

test("selectionLineRange: one whole line ending at column 0 of the next", () => {
  assert.deepEqual(
    selectionLineRange({ start: { row: 3, column: 0 }, end: { row: 4, column: 0 } }),
    { start: 4, end: 4 },
  );
});

test("selectionLineRange: multi-line mid-line end", () => {
  assert.deepEqual(
    selectionLineRange({ start: { row: 3, column: 2 }, end: { row: 6, column: 5 } }),
    { start: 4, end: 7 },
  );
});

test("selectionLineRange: multi-line ending at column 0 drops trailing line", () => {
  assert.deepEqual(
    selectionLineRange({ start: { row: 3, column: 2 }, end: { row: 6, column: 0 } }),
    { start: 4, end: 6 },
  );
});

test("selectionLineRange: empty selection returns null", () => {
  assert.equal(
    selectionLineRange({ start: { row: 3, column: 2 }, end: { row: 3, column: 2 } }),
    null,
  );
});

// ---------------------------------------------------------------------------
// fileUri
// ---------------------------------------------------------------------------

test("fileUri: no range returns the bare file URL", () => {
  const abs = path.resolve("dir", "file.ts");
  assert.equal(fileUri(abs), pathToFileURL(abs).href);
});

test("fileUri: single line appends #L{n}", () => {
  const abs = path.resolve("dir", "file.ts");
  assert.equal(fileUri(abs, { start: 5, end: 5 }), pathToFileURL(abs).href + "#L5");
});

test("fileUri: multi-line appends #L{start}:{end}", () => {
  const abs = path.resolve("dir", "file.ts");
  assert.equal(fileUri(abs, { start: 5, end: 9 }), pathToFileURL(abs).href + "#L5:9");
});

test("fileUri: encodes spaces and non-ASCII but keeps the fragment literal", () => {
  const abs = path.resolve("a b", "r\u00e9sum\u00e9.ts");
  const uri = fileUri(abs, { start: 3, end: 7 });
  assert.ok(uri.startsWith("file://"));
  assert.ok(uri.includes("%20"));
  assert.ok(!uri.includes(" "));
  assert.equal(uri, pathToFileURL(abs).href + "#L3:7");
});

// ---------------------------------------------------------------------------
// buildContextBlock
// ---------------------------------------------------------------------------

test("buildContextBlock: builds an embedded text resource without mimeType", () => {
  assert.deepEqual(buildContextBlock({ uri: "file:///x#L1", text: "hello" }), {
    type: "resource",
    resource: { uri: "file:///x#L1", text: "hello" },
  });
});

// ---------------------------------------------------------------------------
// classifyAuthMethods
// ---------------------------------------------------------------------------

const agentMethod = (id, name = id) => ({ id, name });
const experimentalMethod = (id, type) => ({ id, name: id, type });

test("classifyAuthMethods: no methods yields none", () => {
  assert.deepEqual(classifyAuthMethods([]), { kind: "none" });
});

test("classifyAuthMethods: only experimental methods yields none", () => {
  const methods = [
    experimentalMethod("env", "env_var"),
    experimentalMethod("term", "terminal"),
  ];
  assert.deepEqual(classifyAuthMethods(methods), { kind: "none" });
});

test("classifyAuthMethods: single agent method authenticates automatically", () => {
  const method = agentMethod("oauth", "Sign in with OAuth");
  assert.deepEqual(classifyAuthMethods([method]), { kind: "auto", method });
});

test("classifyAuthMethods: single agent method ignores experimental siblings", () => {
  const method = agentMethod("oauth");
  const result = classifyAuthMethods([
    experimentalMethod("env", "env_var"),
    method,
  ]);
  assert.deepEqual(result, { kind: "auto", method });
});

test("classifyAuthMethods: two agent methods prompt the user", () => {
  const methods = [agentMethod("oauth"), agentMethod("api-key")];
  assert.deepEqual(classifyAuthMethods(methods), { kind: "pick", methods });
});

test("classifyAuthMethods: pick filters out experimental methods", () => {
  const oauth = agentMethod("oauth");
  const apiKey = agentMethod("api-key");
  const result = classifyAuthMethods([
    oauth,
    experimentalMethod("term", "terminal"),
    apiKey,
  ]);
  assert.deepEqual(result, { kind: "pick", methods: [oauth, apiKey] });
});
