/**
 * Keyword dictionary
 *
 * Rewrites sensitive or project-specific keywords into placeholders before a
 * prompt leaves this process, and turns the placeholders back into the original
 * keywords in whatever Claude sends back.
 */

import {
  buildReplacer,
  createStreamTransformer,
  type ReplacementPair,
  type Replacer,
  type StreamTransformer,
} from "./replacer.js";

export interface DictionaryEntry {
  /** The keyword as it appears in the incoming request */
  from: string;
  /** The placeholder sent to Claude in its place */
  to: string;
  caseInsensitive?: boolean;
  wholeWord?: boolean;
}

export interface Dictionary {
  readonly entryCount: number;
  /** False when the file disables itself or holds no usable entries */
  readonly enabled: boolean;
  /** Whether placeholders are mapped back in responses */
  readonly restoreResponses: boolean;
  /** Rewrite keywords into placeholders (outbound) */
  redact(text: string): string;
  /** Rewrite placeholders back into keywords (inbound) */
  restore(text: string): string;
  /** Chunk-safe variant of `restore` for SSE deltas */
  createRestoreStream(): StreamTransformer;
}

export interface ParsedDictionary {
  dictionary: Dictionary;
  warnings: string[];
}

const PASSTHROUGH_STREAM: StreamTransformer = {
  push: (chunk) => chunk,
  flush: () => "",
};

export const EMPTY_DICTIONARY: Dictionary = {
  entryCount: 0,
  enabled: false,
  restoreResponses: false,
  redact: (text) => text,
  restore: (text) => text,
  createRestoreStream: () => PASSTHROUGH_STREAM,
};

const RESERVED_KEYS = new Set([
  "entries",
  "enabled",
  "restoreResponses",
  "caseInsensitive",
  "wholeWord",
]);

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Accepts three shapes:
 *   1. `[{ "from": "...", "to": "..." }, ...]`
 *   2. `{ "entries": [...], "enabled": true, "caseInsensitive": false, ... }`
 *   3. `{ "Acme Corporation": "__ORG_1__", ... }` (shorthand map)
 */
function collectRawEntries(parsed: unknown): {
  raw: unknown[];
  options: Record<string, unknown>;
} {
  if (Array.isArray(parsed)) {
    return { raw: parsed, options: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    return { raw: [], options: {} };
  }

  const options = parsed as Record<string, unknown>;
  if ("entries" in options) {
    const entries = options.entries;
    if (Array.isArray(entries)) {
      return { raw: entries, options };
    }
    if (entries && typeof entries === "object") {
      return {
        raw: Object.entries(entries as Record<string, unknown>).map(([from, to]) => ({
          from,
          to,
        })),
        options,
      };
    }
    return { raw: [], options };
  }

  return {
    raw: Object.entries(options)
      .filter(([key]) => !RESERVED_KEYS.has(key))
      .map(([from, to]) => ({ from, to })),
    options,
  };
}

function normalizeEntry(
  raw: unknown,
  index: number,
  defaults: { caseInsensitive: boolean; wholeWord: boolean },
  warnings: string[]
): DictionaryEntry | null {
  if (!raw || typeof raw !== "object") {
    warnings.push(`entry #${index + 1}: expected an object, got ${typeof raw}`);
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const from = candidate.from ?? candidate.search;
  const to = candidate.to ?? candidate.replace;

  if (typeof from !== "string" || from.length === 0) {
    warnings.push(`entry #${index + 1}: "from" must be a non-empty string`);
    return null;
  }
  if (typeof to !== "string") {
    warnings.push(`entry #${index + 1} ("${from}"): "to" must be a string`);
    return null;
  }
  if (from === to) {
    warnings.push(`entry #${index + 1} ("${from}"): "from" and "to" are identical, skipping`);
    return null;
  }

  return {
    from,
    to,
    caseInsensitive: asBoolean(candidate.caseInsensitive, defaults.caseInsensitive),
    wholeWord: asBoolean(candidate.wholeWord, defaults.wholeWord),
  };
}

export function parseDictionary(parsed: unknown): ParsedDictionary {
  const warnings: string[] = [];
  const { raw, options } = collectRawEntries(parsed);
  const defaults = {
    caseInsensitive: asBoolean(options.caseInsensitive, false),
    wholeWord: asBoolean(options.wholeWord, false),
  };

  const entries: DictionaryEntry[] = [];
  const seenFrom = new Set<string>();
  const seenTo = new Set<string>();

  raw.forEach((item, index) => {
    const entry = normalizeEntry(item, index, defaults, warnings);
    if (!entry) return;

    const fromKey = entry.caseInsensitive ? entry.from.toLowerCase() : entry.from;
    if (seenFrom.has(fromKey)) {
      warnings.push(`entry #${index + 1} ("${entry.from}"): duplicate keyword, skipping`);
      return;
    }
    if (seenTo.has(entry.to)) {
      warnings.push(
        `entry #${index + 1} ("${entry.from}"): placeholder "${entry.to}" is already used by ` +
          "another keyword, so it cannot be restored unambiguously, skipping"
      );
      return;
    }

    seenFrom.add(fromKey);
    seenTo.add(entry.to);
    entries.push(entry);
  });

  return {
    dictionary: createDictionary(entries, {
      enabled: asBoolean(options.enabled, true),
      restoreResponses: asBoolean(options.restoreResponses, true),
    }),
    warnings,
  };
}

export function createDictionary(
  entries: DictionaryEntry[],
  options: { enabled?: boolean; restoreResponses?: boolean } = {}
): Dictionary {
  const enabled = options.enabled !== false && entries.length > 0;
  if (!enabled) {
    return { ...EMPTY_DICTIONARY, entryCount: entries.length };
  }

  const restoreResponses = options.restoreResponses !== false;

  const redactPairs: ReplacementPair[] = entries.map((entry) => ({
    search: entry.from,
    replace: entry.to,
    caseInsensitive: entry.caseInsensitive,
    wholeWord: entry.wholeWord,
  }));

  // Placeholders are emitted by us verbatim, so they are matched exactly:
  // no case folding and no word boundaries on the way back.
  const restorePairs: ReplacementPair[] = entries
    .filter((entry) => entry.to.length > 0)
    .map((entry) => ({ search: entry.to, replace: entry.from }));

  const redactor: Replacer = buildReplacer(redactPairs);
  const restorer: Replacer = restoreResponses
    ? buildReplacer(restorePairs)
    : buildReplacer([]);

  return {
    entryCount: entries.length,
    enabled: true,
    restoreResponses,
    redact: (text) => redactor.apply(text),
    restore: (text) => restorer.apply(text),
    createRestoreStream: () =>
      restorer.size === 0 ? PASSTHROUGH_STREAM : createStreamTransformer(restorer),
  };
}

export { createStreamTransformer, type StreamTransformer } from "./replacer.js";
