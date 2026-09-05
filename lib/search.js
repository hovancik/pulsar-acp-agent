"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/search.ts
var search_exports = {};
__export(search_exports, {
  MAX_REGEX_PATTERN_LENGTH: () => MAX_REGEX_PATTERN_LENGTH,
  MAX_SEARCH_HIGHLIGHTS: () => MAX_SEARCH_HIGHLIGHTS,
  buildSearchRegExp: () => buildSearchRegExp,
  escapeRegExp: () => escapeRegExp,
  isChatMessageBody: () => isChatMessageBody
});
module.exports = __toCommonJS(search_exports);
var MAX_SEARCH_HIGHLIGHTS = 500;
var MAX_REGEX_PATTERN_LENGTH = 200;
function isSafeRegexPattern(pattern) {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  let inCharacterClass = false;
  let hasAlternation = false;
  let quantifierCount = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const escaped = pattern[++index];
      if (escaped === void 0 || /[1-9]/.test(escaped) || escaped === "k") return false;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (char === "(" && pattern[index + 1] === "?") {
      if (pattern[index + 2] !== ":") return false;
      index += 2;
      continue;
    }
    if (char === "|") {
      hasAlternation = true;
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      quantifierCount++;
    }
  }
  return quantifierCount <= 1 && !(hasAlternation && quantifierCount > 0);
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildSearchRegExp(pattern, options) {
  if (pattern.length === 0) return null;
  let source;
  if (options.regex) {
    if (!isSafeRegexPattern(pattern)) return null;
    source = pattern;
  } else {
    source = escapeRegExp(pattern);
  }
  const flags = options.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}
function isChatMessageBody(element) {
  const message = element.closest(".pulsar-acp-agent-message");
  if (!message) return false;
  return message.classList.contains("pulsar-acp-agent-message--user") || message.classList.contains("pulsar-acp-agent-message--agent");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_REGEX_PATTERN_LENGTH,
  MAX_SEARCH_HIGHLIGHTS,
  buildSearchRegExp,
  escapeRegExp,
  isChatMessageBody
});
//# sourceMappingURL=search.js.map
