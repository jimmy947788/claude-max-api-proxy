/**
 * Dictionary file loading
 *
 * The file is read lazily and re-read whenever it changes on disk, so editing
 * it does not require restarting the proxy.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { EMPTY_DICTIONARY, parseDictionary, type Dictionary } from "./dictionary.js";

export const DICTIONARY_PATH_ENV = "KEYWORD_DICTIONARY_FILE";
export const DICTIONARY_DISABLE_ENV = "KEYWORD_DICTIONARY_DISABLED";

const DEFAULT_FILENAME = path.join(".claude-max-proxy", "dictionary.json");

interface CacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  dictionary: Dictionary;
}

let cache: CacheEntry | null = null;
let pending: { filePath: string; promise: Promise<Dictionary> } | null = null;
let lastReportedState = "";

/**
 * Resolve the dictionary path from the environment, falling back to
 * `~/.claude-max-proxy/dictionary.json`.
 */
export function resolveDictionaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DICTIONARY_PATH_ENV]?.trim();
  if (configured) {
    return path.resolve(
      configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured
    );
  }
  return path.join(os.homedir(), DEFAULT_FILENAME);
}

function isDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DICTIONARY_DISABLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Log a message only when it differs from the last one, to keep logs quiet. */
function report(message: string): void {
  if (message === lastReportedState) return;
  lastReportedState = message;
  console.log(`[Dictionary] ${message}`);
}

async function readDictionary(filePath: string): Promise<Dictionary> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache = null;
    report(`no dictionary file at ${filePath}, keyword replacement is off`);
    return EMPTY_DICTIONARY;
  }

  if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.dictionary;
  }

  let dictionary: Dictionary;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const result = parseDictionary(parsed);
    dictionary = result.dictionary;
    for (const warning of result.warnings) {
      console.warn(`[Dictionary] ${filePath}: ${warning}`);
    }
    report(
      dictionary.enabled
        ? `loaded ${dictionary.entryCount} entries from ${filePath}` +
            (dictionary.restoreResponses ? "" : " (response restoration disabled)")
        : `${filePath} has no active entries, keyword replacement is off`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report(`failed to read ${filePath}: ${message}, keyword replacement is off`);
    dictionary = EMPTY_DICTIONARY;
  }

  // Cache the failure too, so a broken file is not re-parsed on every request.
  cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, dictionary };
  return dictionary;
}

/**
 * Get the active dictionary, reloading it if the file changed.
 */
export async function getDictionary(env: NodeJS.ProcessEnv = process.env): Promise<Dictionary> {
  if (isDisabled(env)) return EMPTY_DICTIONARY;

  const filePath = resolveDictionaryPath(env);
  // Collapse concurrent requests onto a single read.
  if (!pending || pending.filePath !== filePath) {
    const promise = readDictionary(filePath).finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { filePath, promise };
  }
  return pending.promise;
}

/** Drop the cached dictionary. Exposed for tests and manual reloads. */
export function resetDictionaryCache(): void {
  cache = null;
  pending = null;
  lastReportedState = "";
}

/** Non-sensitive summary for the health endpoint. */
export async function describeDictionary(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ enabled: boolean; entries: number; restoreResponses: boolean; path: string | null }> {
  if (isDisabled(env)) {
    return { enabled: false, entries: 0, restoreResponses: false, path: null };
  }
  const filePath = resolveDictionaryPath(env);
  const dictionary = await getDictionary(env);
  return {
    enabled: dictionary.enabled,
    entries: dictionary.entryCount,
    restoreResponses: dictionary.restoreResponses,
    path: filePath,
  };
}
