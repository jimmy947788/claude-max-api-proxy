/**
 * Integration tests for keyword substitution across the HTTP layer.
 *
 * Runs the real Express server against a stub that imitates the Claude CLI's
 * stream-json output, so no tokens are spent.
 *
 * Run: npm run test:unit
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "./index.js";
import { resetDictionaryCache } from "../dictionary/loader.js";

/**
 * Stub CLI: records the prompt it was given, then replays FAKE_CLI_REPLY as
 * three-character stream-json deltas so placeholders straddle chunk edges.
 */
const STUB_CLI = `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_CLI_PROMPT_LOG, input);
  const reply = process.env.FAKE_CLI_REPLY;
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const envelope = { session_id: "stub", uuid: "stub" };
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ...envelope });
  for (let i = 0; i < reply.length; i += 3) {
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(i, i + 3) } }, ...envelope });
  }
  const usage = { input_tokens: 5, output_tokens: 7 };
  emit({ type: "assistant", message: { model: "claude-haiku-4-5", id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage }, ...envelope });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: reply, session_id: "stub", total_cost_usd: 0, usage, modelUsage: { "claude-haiku-4-5": { inputTokens: 5, outputTokens: 7, costUSD: 0 } } });
});
`;

const DICTIONARY = {
  entries: [
    { from: "Acme Corporation", to: "__ORG_1__" },
    { from: "alice@acme.test", to: "__EMAIL_1__" },
  ],
};

const KEYWORD_PROMPT = "Mail alice@acme.test about Acme Corporation.";
const PLACEHOLDER_REPLY = "Sure: I will mail __EMAIL_1__ about __ORG_1__ today.";
const RESTORED_REPLY = "Sure: I will mail alice@acme.test about Acme Corporation today.";

let baseUrl: string;
let server: Server;
let tempDir: string;
let promptLog: string;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dict-routes-"));
  promptLog = path.join(tempDir, "prompt.txt");

  const stubPath = path.join(tempDir, "fake-claude.cjs");
  await fs.writeFile(stubPath, STUB_CLI, { mode: 0o755 });

  const dictionaryPath = path.join(tempDir, "dictionary.json");
  await fs.writeFile(dictionaryPath, JSON.stringify(DICTIONARY));

  process.env.CLAUDE_BIN = stubPath;
  process.env.FAKE_CLI_PROMPT_LOG = promptLog;
  process.env.FAKE_CLI_REPLY = PLACEHOLDER_REPLY;
  process.env.KEYWORD_DICTIONARY_FILE = dictionaryPath;
  resetDictionaryCache();

  server = await startServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await stopServer();
  resetDictionaryCache();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function chatRequest(stream: boolean): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      stream,
      messages: [{ role: "user", content: KEYWORD_PROMPT }],
    }),
  });
}

async function readPromptSeenByCli(): Promise<string> {
  return fs.readFile(promptLog, "utf8");
}

describe("keyword dictionary over HTTP", () => {
  it("redacts the prompt and restores the non-streaming response", async () => {
    const res = await chatRequest(false);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    const seen = await readPromptSeenByCli();
    assert.ok(seen.includes("__ORG_1__"), "prompt should reach the CLI redacted");
    assert.ok(seen.includes("__EMAIL_1__"), "prompt should reach the CLI redacted");
    assert.ok(!seen.includes("Acme Corporation"), "keyword leaked to the CLI");
    assert.ok(!seen.includes("alice@acme.test"), "keyword leaked to the CLI");

    assert.equal(body.choices[0].message.content, RESTORED_REPLY);
  });

  it("restores placeholders split across streaming deltas", async () => {
    const res = await chatRequest(true);
    assert.equal(res.status, 200);

    const text = await res.text();
    const content = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
      .join("");

    assert.equal(content, RESTORED_REPLY);
  });

  it("reports dictionary status on /health without exposing keywords", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as any;

    assert.equal(body.dictionary.enabled, true);
    assert.equal(body.dictionary.entries, 2);
    assert.equal(body.dictionary.restoreResponses, true);
    assert.ok(!JSON.stringify(body).includes("Acme Corporation"));
  });

  it("passes text through untouched when the dictionary is disabled", async () => {
    process.env.KEYWORD_DICTIONARY_DISABLED = "1";
    resetDictionaryCache();
    try {
      const res = await chatRequest(false);
      const body = (await res.json()) as any;

      const seen = await readPromptSeenByCli();
      assert.ok(seen.includes("Acme Corporation"), "nothing should be redacted");
      assert.equal(body.choices[0].message.content, PLACEHOLDER_REPLY);
    } finally {
      delete process.env.KEYWORD_DICTIONARY_DISABLED;
      resetDictionaryCache();
    }
  });
});
