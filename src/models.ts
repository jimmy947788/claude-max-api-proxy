/**
 * Single source of truth for models exposed by this proxy.
 *
 * MODEL_IDS mirrors `GET https://api.anthropic.com/v1/models` so clients that
 * match on catalog IDs see exactly what Anthropic serves. Claude Code accepts
 * either an alias (`fable`/`opus`/`sonnet`/`haiku`) or a full model ID, so
 * versioned IDs are passed through verbatim and only bare family names are
 * resolved through aliases.
 */

/** Value passed to `claude --model` — alias or full model ID */
export type ClaudeModel = string;

/** IDs returned by GET /v1/models — mirrors the Anthropic models API */
export const MODEL_IDS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

/** Plugin / provider catalog entries (current generation only) */
export const AVAILABLE_MODELS = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
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
    id: "claude-fable-5",
    name: "Claude Fable 5",
    alias: "fable",
    reasoning: true,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    alias: "opus",
    reasoning: true,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    alias: "sonnet",
    reasoning: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    alias: "haiku",
    reasoning: false,
  },
] as const;

/**
 * Map request model strings → CLI `--model` value.
 *
 * Undated convenience aliases and legacy family shortcuts (`claude-opus-4`,
 * which Anthropic no longer serves) are accepted so existing client configs
 * keep working; they resolve to the current model in that family.
 */
const MODEL_MAP: Record<string, ClaudeModel> = {
  // Claude 5
  "claude-opus-5": "claude-opus-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-fable-5": "claude-fable-5",
  // Opus 4.x
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-opus-4-1": "claude-opus-4-1-20250805",
  // Sonnet 4.x
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  // Haiku
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  // Retired family shortcuts → current model in that family
  "claude-opus-4": "claude-opus-5",
  "claude-sonnet-4": "claude-sonnet-5",
  "claude-haiku-4": "claude-haiku-4-5-20251001",
  // Bare aliases — pin opus to Opus 5 (Claude Code's `opus` still means 4.8)
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "opus-max": "claude-opus-5",
  "sonnet-max": "claude-sonnet-5",
  "fable-max": "claude-fable-5",
};

/**
 * Effort levels each model accepts, per the Anthropic models API
 * `capabilities.effort`. Models absent from this map reject `--effort`.
 */
const EFFORT_SUPPORT: Record<string, readonly string[]> = {
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-5-20251101": ["low", "medium", "high"],
};

/**
 * Whether `--effort <level>` is valid for the given CLI model argument.
 */
export function supportsEffort(model: string, effort: string): boolean {
  return EFFORT_SUPPORT[model]?.includes(effort) ?? false;
}

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
  if (lower.includes("fable") || lower.includes("mythos")) return "claude-fable-5";
  if (lower.includes("opus")) return "claude-opus-5";
  if (lower.includes("sonnet")) return "claude-sonnet-5";
  if (lower.includes("haiku")) return "claude-haiku-4-5-20251001";

  // Default to Opus 5 (Claude Max subscription)
  return "claude-opus-5";
}

/**
 * Normalize CLI-reported model names for OpenAI responses.
 * Keeps the pinned snapshot ID so responses match the /v1/models catalog.
 */
export function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-5";

  return model
    .replace(/^(?:claude-code-cli|claude-max)\//, "")
    .replace(/@(\d{8})$/, "-$1")
    .replace(/-v\d+(?::\d+)?$/, "");
}
