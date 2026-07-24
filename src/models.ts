/**
 * Single source of truth for models exposed by this proxy.
 *
 * Claude Code accepts either an alias (`fable`/`opus`/`sonnet`/`haiku`) or a
 * full model ID (`claude-fable-5`). Prefer full IDs for versioned requests so
 * clients get the exact model; map family shortcuts to aliases so CLI resolves
 * to its current latest.
 */

/** Value passed to `claude --model` — alias or full model ID */
export type ClaudeModel = string;

/** IDs returned by GET /v1/models (newest first within family) */
export const MODEL_IDS = [
  // Claude 5 family
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  // Opus 4.x
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4",
  // Sonnet 4.x
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  // Haiku
  "claude-haiku-4-5",
  "claude-haiku-4",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

/** Plugin / provider catalog entries */
export const AVAILABLE_MODELS = [
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    alias: "fable",
    reasoning: true,
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    alias: "opus",
    reasoning: true,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    alias: "opus",
    reasoning: true,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    alias: "sonnet",
    reasoning: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    alias: "sonnet",
    reasoning: true,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    alias: "haiku",
    reasoning: false,
  },
] as const;

/**
 * Map request model strings → CLI `--model` value.
 * Versioned IDs pass through; family shortcuts use aliases.
 */
const MODEL_MAP: Record<string, ClaudeModel> = {
  // Claude 5
  "claude-fable-5": "claude-fable-5",
  "claude-opus-5": "claude-opus-5",
  "claude-sonnet-5": "claude-sonnet-5",
  // Opus 4.x
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-opus-4": "opus",
  // Sonnet 4.x
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4": "sonnet",
  // Haiku
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-haiku-4": "haiku",
  // Bare aliases (CLI resolves to latest)
  fable: "fable",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
  "fable-max": "fable",
};

/**
 * Extract Claude CLI model arg from an OpenAI request model string.
 */
export function extractModel(model: string): ClaudeModel {
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Pass through full Claude model IDs (e.g. dated snapshots)
  if (/^claude-(fable|opus|sonnet|haiku|mythos)/i.test(stripped)) {
    return stripped;
  }

  const lower = stripped.toLowerCase();
  if (lower.includes("fable") || lower.includes("mythos")) return "fable";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Normalize CLI-reported model names for OpenAI responses.
 * Strips dated suffixes; keeps versioned IDs (e.g. claude-sonnet-5).
 */
export function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-5";

  return model
    .replace(/^(?:claude-code-cli|claude-max)\//, "")
    .replace(/-\d{8}(?:-v\d+(?::\d+)?)?$/, "")
    .replace(/@\d{8}$/, "");
}
