/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentBlock, OpenAIAnyMessage } from "../types/openai.js";
import { extractModel, supportsEffort, type ClaudeModel } from "../models.js";

export type { ClaudeModel };
export { extractModel };

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  /** True when the request originates from Hermes/OpenClaw (needs tool mapping prompt) */
  isOpenClaw: boolean;
  /** Claude Code --effort (low|medium|high|xhigh|max) */
  effort?: string;
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 */
function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === "text" || block.type === "input_text") {
          return block.text ?? "";
        }
        if (block.type === "image_url") {
          const url = block.image_url?.url ?? "";
          // data: URLs are base64-encoded — can't pass inline; note the presence
          if (url.startsWith("data:")) {
            return "[embedded image]";
          }
          return `[Image: ${url}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

const OPENCLAW_SECTION_HEADERS = [
  "## Tooling",
  "## Tool Call Style",
  "## OpenClaw CLI Quick Reference",
  "## OpenClaw Self-Update",
];

/**
 * Detect whether the request comes from Hermes/OpenClaw by checking for
 * OpenClaw-specific section headers in the system prompt.
 */
function detectOpenClaw(messages: OpenAIAnyMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractText(msg.content as string | OpenAIContentBlock[]);
      if (OPENCLAW_SECTION_HEADERS.some((h) => text.includes(h))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI.
 */
export function messagesToPrompt(messages: OpenAIAnyMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content as string | OpenAIContentBlock[]);
    switch (msg.role) {
      case "system": {
        const stripped = stripOpenClawTooling(text);
        parts.push(`<system>\n${stripped}\n</system>\n`);
        break;
      }

      case "user":
        parts.push(text);
        break;

      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;

      case "tool": {
        const toolMsg = msg as import("../types/openai.js").OpenAIToolMessage;
        parts.push(
          `<tool_result tool_call_id="${toolMsg.tool_call_id}">\n${text}\n</tool_result>\n`
        );
        break;
      }
    }
  }

  return parts.join("\n").trim();
}

function extractEffort(request: OpenAIChatRequest): string | undefined {
  const body = request as OpenAIChatRequest & {
    reasoning_effort?: string;
    reasoning?: { effort?: string; enabled?: boolean };
  };
  const raw =
    body.reasoning_effort ||
    (body.reasoning?.enabled === false ? undefined : body.reasoning?.effort);
  if (!raw) return undefined;
  const effort = String(raw).trim().toLowerCase();
  if (["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    return effort;
  }
  return undefined;
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const model = extractModel(request.model);
  const effort = extractEffort(request);
  const isOpenClaw = detectOpenClaw(request.messages);
  return {
    prompt: messagesToPrompt(request.messages),
    model,
    isOpenClaw,
    effort: effort && supportsEffort(model, effort) ? effort : undefined,
  };
}
