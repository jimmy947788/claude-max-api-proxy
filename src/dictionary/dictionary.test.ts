/**
 * Unit tests for the keyword dictionary.
 *
 * Pure in-memory tests — no Claude CLI, no network, no token spend.
 *
 * Run: npm run test:unit
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createDictionary, parseDictionary } from "./dictionary.js";
import { buildReplacer, createStreamTransformer } from "./replacer.js";
import {
  DICTIONARY_DISABLE_ENV,
  DICTIONARY_PATH_ENV,
  getDictionary,
  resetDictionaryCache,
  resolveDictionaryPath,
} from "./loader.js";

const ENTRIES = [
  { from: "Acme Corporation", to: "__ORG_1__" },
  { from: "Acme", to: "__ORG_2__" },
  { from: "alice@acme.test", to: "__EMAIL_1__" },
];

// ─── Redaction ──────────────────────────────────────────────────────

describe("redact", () => {
  it("replaces keywords with their placeholders", () => {
    const dict = createDictionary(ENTRIES);
    assert.equal(
      dict.redact("Email alice@acme.test about Acme Corporation"),
      "Email __EMAIL_1__ about __ORG_1__"
    );
  });

  it("prefers the longest keyword when two overlap", () => {
    const dict = createDictionary(ENTRIES);
    assert.equal(dict.redact("Acme Corporation and Acme"), "__ORG_1__ and __ORG_2__");
  });

  it("never rewrites text produced by an earlier replacement", () => {
    // Without a single pass, "SECRET" -> "TOKEN" would clobber the first result
    const dict = createDictionary([
      { from: "hunter2", to: "SECRET" },
      { from: "SECRET", to: "TOKEN" },
    ]);
    assert.equal(dict.redact("hunter2 and SECRET"), "SECRET and TOKEN");
  });

  it("honours caseInsensitive per entry", () => {
    const dict = createDictionary([
      { from: "acme", to: "__ORG__", caseInsensitive: true },
      { from: "beta", to: "__B__" },
    ]);
    assert.equal(dict.redact("ACME Acme acme"), "__ORG__ __ORG__ __ORG__");
    assert.equal(dict.redact("BETA beta"), "BETA __B__");
  });

  it("honours wholeWord per entry", () => {
    const dict = createDictionary([{ from: "cat", to: "__C__", wholeWord: true }]);
    assert.equal(dict.redact("a cat, concatenate, cat."), "a __C__, concatenate, __C__.");
  });

  it("treats keywords as literals, not patterns", () => {
    const dict = createDictionary([{ from: "a.b(c)", to: "__X__" }]);
    assert.equal(dict.redact("a.b(c) axb(c)"), "__X__ axb(c)");
  });
});

// ─── Restoration ────────────────────────────────────────────────────

describe("restore", () => {
  it("maps placeholders back to the original keywords", () => {
    const dict = createDictionary(ENTRIES);
    assert.equal(
      dict.restore("I emailed __EMAIL_1__ at __ORG_1__."),
      "I emailed alice@acme.test at Acme Corporation."
    );
  });

  it("round-trips a prompt", () => {
    const dict = createDictionary(ENTRIES);
    const original = "Acme Corporation hired Acme, contact alice@acme.test.";
    assert.equal(dict.restore(dict.redact(original)), original);
  });

  it("is a no-op when restoreResponses is off", () => {
    const dict = createDictionary(ENTRIES, { restoreResponses: false });
    assert.equal(dict.redact("Acme"), "__ORG_2__");
    assert.equal(dict.restore("__ORG_2__"), "__ORG_2__");
  });

  it("restores symbolic placeholders case-sensitively", () => {
    const dict = createDictionary([
      { from: "Acme", to: "__ORG__", caseInsensitive: true },
    ]);
    assert.equal(dict.restore("__org__"), "__org__");
    assert.equal(dict.restore("__ORG__"), "Acme");
  });

  it("restores every case of a plain-word placeholder", () => {
    const dict = createDictionary([
      { from: "bank", to: "blue", caseInsensitive: true },
      { from: "production", to: "development", caseInsensitive: true },
    ]);
    assert.equal(dict.restore("blue"), "bank");
    assert.equal(dict.restore("Blue"), "Bank");
    assert.equal(dict.restore("BLUE"), "BANK");
    assert.equal(dict.restore("dblue"), "dbank");
    assert.equal(dict.restore("dBlue"), "dBank");
    assert.equal(dict.restore("DBLUE"), "DBANK");
    assert.equal(dict.restore("com.dblue.mobile"), "com.dbank.mobile");
    assert.equal(dict.restore("DEVELOPMENT"), "PRODUCTION");
    assert.equal(dict.restore("Development"), "Production");
  });

  it("keeps the matched case when redacting a plain word", () => {
    const dict = createDictionary([{ from: "bank", to: "blue", caseInsensitive: true }]);
    assert.equal(dict.redact("bank"), "blue");
    assert.equal(dict.redact("Bank"), "Blue");
    assert.equal(dict.redact("DBANK"), "DBLUE");
    assert.equal(dict.redact("dBank"), "dBlue");
    assert.equal(dict.restore(dict.redact("DBANK dBank bank")), "DBANK dBank bank");
  });
});

// ─── Streaming restoration ──────────────────────────────────────────

describe("streaming restore", () => {
  /** Feed the text one character at a time — the worst-case chunking. */
  function streamByChar(dict: ReturnType<typeof createDictionary>, text: string): string {
    const stream = dict.createRestoreStream();
    let out = "";
    for (const char of text) out += stream.push(char);
    return out + stream.flush();
  }

  it("restores a cased word placeholder split across chunks", () => {
    const dict = createDictionary([{ from: "bank", to: "blue", caseInsensitive: true }]);
    const stream = dict.createRestoreStream();
    assert.equal(stream.push("see DB"), "see D");
    assert.equal(stream.push("LUE"), "BANK");
    assert.equal(stream.flush(), "");

    const titled = dict.createRestoreStream();
    assert.equal(titled.push("dBl"), "d");
    assert.equal(titled.push("ue"), "Bank");
    assert.equal(titled.flush(), "");
  });

  it("restores a placeholder split across chunks", () => {
    const dict = createDictionary(ENTRIES);
    const stream = dict.createRestoreStream();
    let out = "";
    out += stream.push("hello __OR");
    out += stream.push("G_1__ bye");
    out += stream.flush();
    assert.equal(out, "hello Acme Corporation bye");
  });

  it("restores correctly for every possible chunk boundary", () => {
    const dict = createDictionary(ENTRIES);
    const text = "__ORG_1__ met __ORG_2__ and mailed __EMAIL_1__ twice: __ORG_1__";
    const expected = dict.restore(text);

    for (let split = 0; split <= text.length; split++) {
      const stream = dict.createRestoreStream();
      const out =
        stream.push(text.slice(0, split)) + stream.push(text.slice(split)) + stream.flush();
      assert.equal(out, expected, `wrong output when split at ${split}`);
    }
  });

  it("handles character-by-character delivery", () => {
    const dict = createDictionary(ENTRIES);
    assert.equal(
      streamByChar(dict, "__ORG_2__ then __ORG_1__"),
      "Acme then Acme Corporation"
    );
  });

  it("waits for the longer placeholder before emitting a shorter prefix", () => {
    const dict = createDictionary([
      { from: "short", to: "__P__" },
      { from: "long", to: "__P__X" },
    ]);
    const stream = dict.createRestoreStream();
    assert.equal(stream.push("__P__"), "", "must not commit while __P__X is still possible");
    assert.equal(stream.push("X"), "long");
    assert.equal(stream.flush(), "");
  });

  it("emits a trailing partial placeholder verbatim on flush", () => {
    const dict = createDictionary(ENTRIES);
    const stream = dict.createRestoreStream();
    assert.equal(stream.push("done __ORG"), "done ");
    assert.equal(stream.flush(), "__ORG");
  });

  it("passes text through unchanged when there are no entries", () => {
    const dict = createDictionary([]);
    const stream = dict.createRestoreStream();
    assert.equal(stream.push("anything"), "anything");
    assert.equal(stream.flush(), "");
  });

  it("holds back at most one placeholder's worth of text", () => {
    const replacer = buildReplacer([{ search: "__ORG_1__", replace: "Acme" }]);
    const stream = createStreamTransformer(replacer);
    // Underscores are the worst case here: every suffix looks like a prefix
    let emitted = "";
    for (let i = 0; i < 1000; i++) emitted += stream.push("_");
    assert.ok(
      emitted.length >= 1000 - "__ORG_1__".length,
      `buffered ${1000 - emitted.length} characters`
    );
    emitted += stream.flush();
    assert.equal(emitted, "_".repeat(1000));
  });
});

// ─── Parsing ────────────────────────────────────────────────────────

describe("parseDictionary", () => {
  it("accepts the shorthand map form", () => {
    const { dictionary, warnings } = parseDictionary({ Acme: "__ORG__" });
    assert.deepEqual(warnings, []);
    assert.equal(dictionary.entryCount, 1);
    assert.equal(dictionary.redact("Acme"), "__ORG__");
  });

  it("accepts the entries array form with options", () => {
    const { dictionary } = parseDictionary({
      caseInsensitive: true,
      entries: [{ from: "Acme", to: "__ORG__" }],
    });
    assert.equal(dictionary.redact("acme"), "__ORG__");
  });

  it("lets an entry override a top-level option", () => {
    const { dictionary } = parseDictionary({
      caseInsensitive: true,
      entries: [{ from: "Acme", to: "__ORG__", caseInsensitive: false }],
    });
    assert.equal(dictionary.redact("acme"), "acme");
  });

  it("accepts a bare array", () => {
    const { dictionary } = parseDictionary([{ from: "Acme", to: "__ORG__" }]);
    assert.equal(dictionary.entryCount, 1);
  });

  it("disables itself when enabled is false", () => {
    const { dictionary } = parseDictionary({
      enabled: false,
      entries: [{ from: "Acme", to: "__ORG__" }],
    });
    assert.equal(dictionary.enabled, false);
    assert.equal(dictionary.redact("Acme"), "Acme");
  });

  it("warns and skips invalid entries", () => {
    const { dictionary, warnings } = parseDictionary({
      entries: [
        { from: "", to: "__A__" },
        { from: "ok", to: "__B__" },
        { from: "ok", to: "__C__" },
        { from: "same", to: "same" },
        { from: "other", to: "__B__" },
      ],
    });
    assert.equal(dictionary.entryCount, 1);
    assert.equal(warnings.length, 4);
  });

  it("returns an inert dictionary for junk input", () => {
    for (const junk of [null, 42, "nope", undefined]) {
      const { dictionary } = parseDictionary(junk);
      assert.equal(dictionary.enabled, false);
      assert.equal(dictionary.redact("Acme"), "Acme");
    }
  });
});

// ─── Loader ─────────────────────────────────────────────────────────

describe("loader", () => {
  it("resolves the path from the environment", () => {
    assert.equal(
      resolveDictionaryPath({ [DICTIONARY_PATH_ENV]: "/tmp/dict.json" }),
      "/tmp/dict.json"
    );
    assert.equal(
      resolveDictionaryPath({ [DICTIONARY_PATH_ENV]: "~/dict.json" }),
      path.join(os.homedir(), "dict.json")
    );
    assert.ok(resolveDictionaryPath({}).endsWith(path.join(".claude-max-proxy", "dictionary.json")));
  });

  it("loads a file, reloads it on change, and tolerates a missing one", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dict-test-"));
    const file = path.join(dir, "dictionary.json");
    const env = { [DICTIONARY_PATH_ENV]: file } as NodeJS.ProcessEnv;

    try {
      resetDictionaryCache();
      assert.equal((await getDictionary(env)).enabled, false, "missing file must be inert");

      await fs.writeFile(file, JSON.stringify({ Acme: "__ORG__" }));
      resetDictionaryCache();
      assert.equal((await getDictionary(env)).redact("Acme"), "__ORG__");

      // mtime has 1s granularity on some filesystems, so change the size too
      await fs.writeFile(file, JSON.stringify({ Acme: "__ORG__", Beta: "__BETA__" }));
      assert.equal((await getDictionary(env)).redact("Beta"), "__BETA__");

      await fs.writeFile(file, "{ not json");
      const broken = await getDictionary(env);
      assert.equal(broken.enabled, false, "a broken file must not break requests");
    } finally {
      resetDictionaryCache();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stays off when disabled by the environment", async () => {
    resetDictionaryCache();
    const dict = await getDictionary({
      [DICTIONARY_PATH_ENV]: "/tmp/does-not-matter.json",
      [DICTIONARY_DISABLE_ENV]: "1",
    });
    assert.equal(dict.enabled, false);
  });
});
