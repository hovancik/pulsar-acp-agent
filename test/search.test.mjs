import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchRegExp,
  escapeRegExp,
  isChatMessageBody,
  MAX_REGEX_PATTERN_LENGTH,
} from "../lib/search.js";

test("escapeRegExp: escapes special characters", () => {
  assert.equal(escapeRegExp("a.*+?"), "a\\.\\*\\+\\?");
  assert.equal(escapeRegExp("(test) [a] {1}"), "\\(test\\) \\[a\\] \\{1\\}");
});

test("buildSearchRegExp: empty pattern returns null", () => {
  assert.equal(buildSearchRegExp("", { caseSensitive: false, regex: false }), null);
});

test("buildSearchRegExp: plain search is case-insensitive by default", () => {
  const re = buildSearchRegExp("hello", { caseSensitive: false, regex: false });
  assert.ok(re);
  assert.equal(re.flags, "gi");
  assert.ok(re.test("Hello"));
  re.lastIndex = 0;
  assert.ok(re.test("HELLO"));
});

test("buildSearchRegExp: caseSensitive adds no i flag", () => {
  const re = buildSearchRegExp("hello", { caseSensitive: true, regex: false });
  assert.ok(re);
  assert.equal(re.flags, "g");
  assert.equal(re.test("Hello"), false);
  assert.ok(re.test("hello"));
});

test("buildSearchRegExp: plain search escapes regex meta", () => {
  const re = buildSearchRegExp("a.*", { caseSensitive: false, regex: false });
  assert.ok(re);
  assert.equal(re.test("a.*"), true);
  assert.equal(re.test("aX"), false);
});

test("buildSearchRegExp: regex mode respects pattern", () => {
  const re = buildSearchRegExp("a.*b", { caseSensitive: false, regex: true });
  assert.ok(re);
  assert.ok(re.test("axxb"));
  re.lastIndex = 0;
  assert.ok(re.test("ab"));
});

test("buildSearchRegExp: invalid regex returns null", () => {
  assert.equal(buildSearchRegExp("[", { caseSensitive: false, regex: true }), null);
  assert.equal(buildSearchRegExp("(", { caseSensitive: false, regex: true }), null);
});

test("buildSearchRegExp: rejects unsafe regex patterns", () => {
  // Patterns are built from concatenated parts (not regex literals or single
  // string constants) so static analyzers don't need to reason about the
  // exponential-backtracking shapes: buildSearchRegExp rejects them before
  // they ever reach `new RegExp`, which is exactly what this test verifies.
  const nestedQuantifier = "^(" + "a+" + ")+$";
  const nestedAlternation = "^(" + "a|a" + ")+$";
  const nestedWildcard = "(" + "." + "*" + ")*";
  const nestedWordGroup = "(" + "\\w+\\s?" + ")*";
  const quantifiedBackref = "(a)" + "\\1+";
  for (const pattern of [
    nestedQuantifier,
    nestedAlternation,
    nestedWildcard,
    nestedWordGroup,
    quantifiedBackref,
  ]) {
    assert.equal(buildSearchRegExp(pattern, { caseSensitive: false, regex: true }), null);
  }
});

test("buildSearchRegExp: limits only regex patterns", () => {
  const longPattern = "x".repeat(MAX_REGEX_PATTERN_LENGTH + 1);
  assert.equal(buildSearchRegExp(longPattern, { caseSensitive: false, regex: true }), null);
  assert.ok(buildSearchRegExp(longPattern, { caseSensitive: false, regex: false }));
});

test("buildSearchRegExp: always has global flag", () => {
  const re1 = buildSearchRegExp("x", { caseSensitive: false, regex: false });
  const re2 = buildSearchRegExp("x", { caseSensitive: true, regex: true });
  assert.ok(re1.flags.includes("g"));
  assert.ok(re2.flags.includes("g"));
});

test("isChatMessageBody: returns true only for user/agent bodies", () => {
  // Minimal DOM shim without JSDOM: use simple object with closest.
  const makeEl = (classes, parentClasses) => ({
    closest: (sel) => {
      // sel is ".pulsar-acp-agent-message"
      if (sel === ".pulsar-acp-agent-message") {
        if (!parentClasses) return null;
        return {
          classList: { contains: (c) => parentClasses.includes(c) },
        };
      }
      return null;
    },
  });
  // Not inside any message -> false
  assert.equal(isChatMessageBody(makeEl([], null)), false);
  // Inside user
  assert.equal(
    isChatMessageBody(makeEl([], ["pulsar-acp-agent-message", "pulsar-acp-agent-message--user"])),
    true,
  );
  assert.equal(
    isChatMessageBody(makeEl([], ["pulsar-acp-agent-message", "pulsar-acp-agent-message--agent"])),
    true,
  );
  // Inside thought -> false
  assert.equal(
    isChatMessageBody(makeEl([], ["pulsar-acp-agent-message", "pulsar-acp-agent-message--thought"])),
    false,
  );
  assert.equal(
    isChatMessageBody(makeEl([], ["pulsar-acp-agent-message", "pulsar-acp-agent-message--note"])),
    false,
  );
});
