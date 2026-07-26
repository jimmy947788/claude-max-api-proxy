# claude-max-api-proxy 優化審計 2026-07-26

HackMD 文件是 Hermes Agent & Honcho 架構概述。以下是讀完 proxy 完整代碼後的發現。

---

## P0 — 直接 Bug，影響正確性

### 1. `role: "tool"` 訊息被靜默丟棄
**位置**: `src/adapter/openai-to-cli.ts` → `messagesToPrompt()`

`switch(msg.role)` 只有 `system` / `user` / `assistant` 三個 case，沒有 `tool`。
OpenAI 多輪 function call 流程會送 `{ role: "tool", content: "...", tool_call_id: "..." }`
這些訊息直接跳過，工具結果全丟，multi-turn tool call 對話必爛。

**修法**: 加一個 case：
```ts
case "tool":
  parts.push(`<tool_result tool_call_id="${(msg as any).tool_call_id}">\n${text}\n</tool_result>\n`);
  break;
```

### 2. Streaming 中 `result.is_error && hasEmittedText` → 錯誤被靜默掩蓋
**位置**: `src/server/routes.ts` → `subprocess.on("result")` handler

```ts
if (result.is_error && !hasEmittedText) {
  // 正確：回送 error chunk
}
// 但如果 is_error 且 hasEmittedText == true → 直接送 doneChunk(finish_reason: "stop")
// 客戶端以為成功，但 Claude 實際返回了錯誤
```

**修法**: 分開兩個判斷：
```ts
if (result.is_error) {
  // log 錯誤; 如果還沒送過文字則送 error chunk
  // 無論如何，finish_reason 應該用 "stop" 還是不同值？
  // 至少要 console.error
}
```

---

## P1 — 死代碼 / 資源浪費

### 3. `SessionManager` 完全是死代碼
**位置**: `src/session/manager.ts`

完整的 load/save/cleanup/getOrCreate 實作，但 `routes.ts` 根本沒 import 它。
它每小時觸發一次 cleanup，每次新 session 寫 `~/.claude-code-cli-sessions.json`，但對 proxy 行為零影響。

**選擇**:
- Option A: 刪除 `session/manager.ts`（推薦，目前 stateless 設計是對的）
- Option B: 真的要 session 連續性才接回來

### 4. `--no-session-persistence` + `--session-id` 永遠共存
**位置**: `src/subprocess/manager.ts` → `buildArgs()`

```ts
"--no-session-persistence",  // 永遠加
// ...
if (options.sessionId) {
  args.push("--session-id", options.sessionId);  // 有時加
}
```

`--no-session-persistence` 代表「不儲存 session」，加了 `--session-id` 等於「載入這個 session 但不存回去」。
如果 proxy 是 stateless（每次 full prompt），`--session-id` 本身就沒意義，應該整個拿掉。

**修法**: 如果維持 stateless 設計，從 `openaiToCli` 移除 `sessionId` 欄位，`buildArgs` 裡拿掉 `--session-id` 分支。

### 5. `extractTextContent` 未被使用
**位置**: `src/adapter/cli-to-openai.ts` line ~13

定義了 `extractTextContent(message: ClaudeCliAssistant)` 但從未調用。
Non-streaming 路徑直接用 `result.result`，streaming 路徑自行解析。

**修法**: 刪除或在 `cliResultToOpenai` 中實際使用它。

### 6. `OPENCLAW_TOOL_MAPPING_PROMPT` 無條件注入
**位置**: `src/subprocess/manager.ts` → `buildArgs()`

每個請求（~50 行文字）都透過 `--append-system-prompt` 注入，不管 caller 是不是 Hermes/OpenClaw。
如果是其他 client（比如 curl 測試、第三方工具），等於每次浪費 ~200 token。

**可選優化**: 在 `openaiToCli` 中偵測 system prompt 是否包含 OpenClaw 關鍵字（`exec`, `openclaw`, `skill_view` 等），只有命中時才注入。

---

## P2 — 功能缺失

### 7. `image_url` content block 靜默丟棄
**位置**: `src/adapter/openai-to-cli.ts` → `extractText()`

```ts
.filter((block) => block.type === "text" || block.type === "input_text")
```

`image_url` 類型的 block 直接過濾掉，沒有警告。Opus 5 / Sonnet 5 都支援 vision，但這樣的 proxy 永遠看不到圖片。

---

## P3 — 小問題

### 8. JSON 解析失敗回 500 而非 400
**位置**: `src/server/index.ts` body parser middleware

`next(err)` 打到 generic error handler → 500。應該是 400 Bad Request。

### 9. `request.user` 作為 session ID 的提取很脆
**位置**: `src/adapter/openai-to-cli.ts` → `openaiToCli()`

```ts
sessionId: user && UUID_RE.test(user) ? user : undefined,
```

Hermes 送的 session key 如果不是 UUID 格式就整個忽略。目前可能剛好是 UUID，但沒有保證。

---

## 優先順序建議

| 優先 | 問題 | 影響 |
|------|------|------|
| 立刻修 | #1 tool messages 丟失 | multi-turn tool call 對話全爛 |
| 立刻修 | #2 is_error 掩蓋 | 錯誤被當成功回報 |
| 清理 | #3 SessionManager 死代碼 | 無功能但佔 code / 寫磁碟 |
| 清理 | #4 --session-id 無效 | 概念上混亂 |
| 清理 | #5 extractTextContent 未使用 | dead code |
| 優化 | #6 OPENCLAW prompt 無條件注入 | 浪費 token |
| 功能 | #7 image_url 丟棄 | vision 無法用 |
| 小修 | #8 400 vs 500 | HTTP 語義錯誤 |
