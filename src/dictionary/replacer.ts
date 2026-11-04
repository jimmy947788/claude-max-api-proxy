/**
 * Single-pass keyword replacement
 *
 * Builds one alternation regex from every term so each character of the input
 * is consumed at most once. That matters here: replacing terms one-by-one would
 * let a later term match text that an earlier replacement just produced, which
 * would corrupt the mapping and make restoration impossible.
 */

export interface ReplacementPair {
  /** Text to look for */
  search: string;
  /** Text to put in its place */
  replace: string;
  caseInsensitive?: boolean;
  wholeWord?: boolean;
  /**
   * Copy the case of the matched text onto `replace`.
   * Used for plain-word placeholders (`blue` / `BLUE` / `dBlue`).
   */
  preserveCase?: boolean;
}

export interface SplitResult {
  /** Text that is safe to emit now, with every settled match replaced */
  emit: string;
  /** Trailing text that might still grow into a match */
  keep: string;
}

export interface Replacer {
  readonly size: number;
  apply(text: string): string;
  /**
   * Replace what can be decided from `text` alone and hold back the rest.
   * Used by the streaming transformer, where a term may span chunks.
   */
  split(text: string): SplitResult;
}

export interface StreamTransformer {
  /** Feed a chunk; returns the text that is safe to emit now. */
  push(chunk: string): string;
  /** Emit whatever is still buffered. */
  flush(): string;
}

const IDENTITY_REPLACER: Replacer = {
  size: 0,
  apply: (text) => text,
  split: (text) => ({ emit: text, keep: "" }),
};

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a literal pattern one character at a time. Case-insensitive terms are
 * expanded into character classes instead of using the `i` flag, because the
 * flag is per-regex and entries opt in individually.
 */
function literalPattern(term: string, caseInsensitive: boolean): string {
  return Array.from(term)
    .map((char) => {
      if (!caseInsensitive) return escapeRegex(char);
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      if (lower === upper) return escapeRegex(char);
      return `[${escapeRegex(lower)}${escapeRegex(upper)}]`;
    })
    .join("");
}

/** True when every character is a letter or digit, so case can be transferred. */
export function isCaseWord(text: string): boolean {
  return /^[\p{L}\p{N}]+$/u.test(text);
}

/**
 * Replay the case pattern of `matched` onto `replacement`.
 * `BLUE` → all caps, `blue` → all lower, `Blue` → leading capital.
 * Mixed patterns follow the matched characters and reuse the last one
 * when the replacement is longer.
 */
export function applyMatchedCase(matched: string, replacement: string): string {
  if (matched === matched.toUpperCase()) return replacement.toUpperCase();
  if (matched === matched.toLowerCase()) return replacement.toLowerCase();

  const matchedChars = Array.from(matched);
  const head = matchedChars[0] ?? "";
  const tail = matchedChars.slice(1).join("");
  if (head === head.toUpperCase() && tail === tail.toLowerCase()) {
    const replacementChars = Array.from(replacement);
    const first = replacementChars[0] ?? "";
    return first.toUpperCase() + replacementChars.slice(1).join("").toLowerCase();
  }

  const sample = matchedChars;
  return Array.from(replacement)
    .map((char, index) => {
      const source = sample[index] ?? sample[sample.length - 1] ?? "";
      if (source !== source.toLowerCase() && source === source.toUpperCase()) {
        return char.toUpperCase();
      }
      if (source !== source.toUpperCase() && source === source.toLowerCase()) {
        return char.toLowerCase();
      }
      return char;
    })
    .join("");
}

function wordBoundaryWrap(pattern: string, term: string): string {
  const prefix = /^[\p{L}\p{N}_]/u.test(term) ? "(?<![\\p{L}\\p{N}_])" : "";
  const suffix = /[\p{L}\p{N}_]$/u.test(term) ? "(?![\\p{L}\\p{N}_])" : "";
  return `${prefix}${pattern}${suffix}`;
}

interface Match {
  start: number;
  end: number;
  text: string;
  replacement: string;
}

export function buildReplacer(pairs: ReplacementPair[]): Replacer {
  const usable = pairs.filter((pair) => pair.search.length > 0);
  if (usable.length === 0) return IDENTITY_REPLACER;

  // Longest first so "Acme Corporation" wins over "Acme" in the alternation,
  // and so a complete match can never be the start of a longer one mid-text.
  const ordered = [...usable].sort((a, b) => b.search.length - a.search.length);

  const pattern = ordered
    .map((pair) => {
      const literal = literalPattern(pair.search, pair.caseInsensitive === true);
      return `(${pair.wholeWord ? wordBoundaryWrap(literal, pair.search) : literal})`;
    })
    .join("|");
  const regex = new RegExp(pattern, "gu");

  // Every string a still-incomplete match could consist of. A whole-word term
  // also needs its full form here: at the end of a buffer we cannot yet tell
  // whether the next character would break the trailing word boundary.
  const caseSensitivePrefixes = new Set<string>();
  const caseInsensitivePrefixes = new Set<string>();
  let maxPrefixLength = 0;

  for (const pair of ordered) {
    const target =
      pair.caseInsensitive === true ? caseInsensitivePrefixes : caseSensitivePrefixes;
    const longest = pair.wholeWord === true ? pair.search.length : pair.search.length - 1;
    for (let length = 1; length <= longest; length++) {
      const prefix = pair.search.slice(0, length);
      target.add(pair.caseInsensitive === true ? prefix.toLowerCase() : prefix);
    }
    maxPrefixLength = Math.max(maxPrefixLength, longest);
  }

  function couldGrow(text: string): boolean {
    return (
      caseSensitivePrefixes.has(text) || caseInsensitivePrefixes.has(text.toLowerCase())
    );
  }

  /** Exactly one capture group is set per match; its position names the entry. */
  function replacementFor(matched: string, groups: (string | undefined)[]): string {
    const index = groups.findIndex((group) => group !== undefined);
    if (index === -1) return matched;
    const pair = ordered[index];
    return pair.preserveCase === true ? applyMatchedCase(matched, pair.replace) : pair.replace;
  }

  function findMatches(text: string): Match[] {
    const matches: Match[] = [];
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        replacement: replacementFor(match[0], match.slice(1)),
      });
      if (match[0].length === 0) regex.lastIndex++;
    }
    return matches;
  }

  return {
    size: ordered.length,

    apply(text: string): string {
      if (!text) return text;
      regex.lastIndex = 0;
      return text.replace(regex, (matched: string, ...rest: unknown[]) =>
        replacementFor(matched, rest.slice(0, ordered.length) as (string | undefined)[])
      );
    },

    split(text: string): SplitResult {
      if (!text) return { emit: "", keep: "" };

      const matches = findMatches(text);
      const last = matches[matches.length - 1];

      // A match that ends at the buffer edge may just be the start of a longer
      // term, so it stays uncommitted until the next chunk settles it.
      const settled =
        last && last.end === text.length && couldGrow(last.text)
          ? matches.slice(0, -1)
          : matches;

      let emit = "";
      let cursor = 0;
      for (const match of settled) {
        emit += text.slice(cursor, match.start) + match.replacement;
        cursor = match.end;
      }

      // Everything past the last settled match holds no complete match, so only
      // its longest "could still grow" suffix needs to be withheld.
      const rest = text.slice(cursor);
      let keepFrom = rest.length;
      const limit = Math.min(rest.length, maxPrefixLength);
      for (let length = limit; length >= 1; length--) {
        if (couldGrow(rest.slice(rest.length - length))) {
          keepFrom = rest.length - length;
          break;
        }
      }

      return { emit: emit + rest.slice(0, keepFrom), keep: rest.slice(keepFrom) };
    },
  };
}

/**
 * Wrap a replacer so it can be applied to a stream of chunks.
 *
 * A term can be split across chunk boundaries, so the transformer holds back
 * any trailing text that might still turn into a match and emits it once the
 * next chunk (or `flush()`) resolves the ambiguity.
 */
export function createStreamTransformer(replacer: Replacer): StreamTransformer {
  let buffer = "";

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      if (replacer.size === 0) return chunk;

      buffer += chunk;
      const { emit, keep } = replacer.split(buffer);
      buffer = keep;
      return emit;
    },

    flush(): string {
      if (!buffer) return "";
      const emitted = replacer.apply(buffer);
      buffer = "";
      return emitted;
    },
  };
}
