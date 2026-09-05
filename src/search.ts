export type SearchOptions = {
  caseSensitive: boolean;
  regex: boolean;
};

export const MAX_SEARCH_HIGHLIGHTS = 500;
export const MAX_REGEX_PATTERN_LENGTH = 200;

function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;

  let inCharacterClass = false;
  let hasAlternation = false;
  let quantifierCount = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const escaped = pattern[++index];
      if (escaped === undefined || /[1-9]/.test(escaped) || escaped === "k") return false;
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

  // JavaScript cannot interrupt a running regular expression. Restrict regex
  // mode to patterns whose bounded scan cannot introduce backtracking loops.
  return quantifierCount <= 1 && !(hasAlternation && quantifierCount > 0);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchRegExp(
  pattern: string,
  options: SearchOptions,
): RegExp | null {
  if (pattern.length === 0) return null;
  let source: string;
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

export function isChatMessageBody(element: Element): boolean {
  const message = element.closest(".pulsar-acp-agent-message");
  if (!message) return false;
  return (
    message.classList.contains("pulsar-acp-agent-message--user") ||
    message.classList.contains("pulsar-acp-agent-message--agent")
  );
}
