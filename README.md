# Claude Max API Proxy

> Actively maintained fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) with OpenClaw integration, improved streaming, and expanded model support.

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku with flexible model aliases
- **OpenClaw integration** — Automatic tool name mapping and system prompt adaptation
- **Keyword dictionary** — Swap private keywords for placeholders before the prompt leaves your machine, and swap them back in the reply
- **Content block handling** — Proper text block separators for multi-block responses
- **Session management** — Maintains conversation context via session IDs
- **Auto-start service** — Optional systemd user unit (Linux) or LaunchAgent (macOS)
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses `spawn()` to prevent shell injection

## What's Different from the Original

- **OpenClaw tool mapping** — Maps OpenClaw tool names (`exec`, `read`, `web_search`, etc.) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System prompt stripping** — Removes OpenClaw-specific tooling sections that confuse the CLI
- **Content block support** — Handles `input_text` content blocks and multi-block text separators
- **Tool call types** — Full OpenAI tool call type definitions for streaming and non-streaming
- **Improved streaming** — Better SSE handling with connection confirmation and client disconnect detection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/jimmy947788/claude-max-api-proxy.git
cd claude-max-api-proxy

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

`GET /v1/models` mirrors Anthropic's own model catalog:

| Model ID | Context / max output | `--effort` levels |
|----------|----------------------|-------------------|
| `claude-opus-5` | 1M / 128K | low, medium, high, xhigh, max |
| `claude-sonnet-5` | 1M / 128K | low, medium, high, xhigh, max |
| `claude-fable-5` | 1M / 128K | low, medium, high, xhigh, max |
| `claude-opus-4-8` | 1M / 128K | low, medium, high, xhigh, max |
| `claude-opus-4-7` | 1M / 128K | low, medium, high, xhigh, max |
| `claude-sonnet-4-6` | 1M / 128K | low, medium, high, max |
| `claude-opus-4-6` | 1M / 128K | low, medium, high, max |
| `claude-opus-4-5-20251101` | 200K / 64K | low, medium, high |
| `claude-haiku-4-5-20251001` | 200K / 64K | not supported |
| `claude-sonnet-4-5-20250929` | 1M / 64K | not supported |
| `claude-opus-4-1-20250805` | 200K / 32K | not supported |

Undated forms of the dated IDs are accepted too (`claude-opus-4-5`, `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-1`), as are the bare aliases `fable`, `opus`, `sonnet`, and `haiku`. `opus` / `opus-max` / the retired `claude-opus-4` resolve to `claude-opus-5` (Claude Code's own bare `opus` alias still points at 4.8).

All model IDs also accept a `claude-code-cli/` or `claude-max/` prefix (e.g., `claude-code-cli/claude-fable-5`). Unknown models default to Opus 5.

`reasoning_effort` (or `reasoning.effort`) is forwarded to Claude Code as `--effort`, and dropped for models that do not accept it.

Model definitions live in `src/models.ts` (single source of truth for `/v1/models`, CLI mapping, and the plugin catalog).

## Keyword Dictionary (redact & restore)

Some prompts contain names, paths, or identifiers you would rather not send to
Anthropic. The proxy can rewrite them into placeholders on the way out and turn
the placeholders back into the originals on the way in, so the client never sees
the substitution.

```
Client ──"Mail alice@acme.test"──▶ Proxy ──"Mail __EMAIL_1__"──▶ Claude
Client ◀──"Mailed alice@acme.test"── Proxy ◀──"Mailed __EMAIL_1__"── Claude
```

### Enabling it

Create the dictionary file — by default `~/.claude-max-proxy/dictionary.json`:

```json
{
  "entries": [
    { "from": "Acme Corporation", "to": "__ORG_1__" },
    { "from": "alice@acme.test", "to": "__EMAIL_1__", "caseInsensitive": true },
    { "from": "/Users/alice/work/acme-internal", "to": "__REPO_PATH__" }
  ]
}
```

A plain keyword-to-placeholder map works too:

```json
{
  "Acme Corporation": "__ORG_1__",
  "alice@acme.test": "__EMAIL_1__"
}
```

There is nothing else to turn on: with no file present, the proxy behaves exactly
as before. The file is re-read whenever it changes, so edits take effect on the
next request without a restart. A full example lives in
[`docs/dictionary.example.json`](docs/dictionary.example.json).

### Options

| Key | Scope | Default | Meaning |
|-----|-------|---------|---------|
| `from` | entry | — | The keyword to look for (matched literally, not as a regex) |
| `to` | entry | — | The placeholder sent to Claude in its place |
| `caseInsensitive` | entry / file | `false` | Match the keyword regardless of case |
| `wholeWord` | entry / file | `false` | Only match when not surrounded by letters, digits, or `_` |
| `enabled` | file | `true` | Set to `false` to keep the file but turn substitution off |
| `restoreResponses` | file | `true` | Set to `false` to redact prompts without mapping replies back |

`caseInsensitive` and `wholeWord` set at the top level act as defaults that each
entry can override.

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `KEYWORD_DICTIONARY_FILE` | `~/.claude-max-proxy/dictionary.json` | Path to the dictionary |
| `KEYWORD_DICTIONARY_DISABLED` | unset | Set to `1` to bypass the dictionary entirely |

`GET /health` reports whether a dictionary is loaded and how many entries it
holds. It never returns the keywords themselves.

### Behaviour notes

- Keywords are matched in a single pass, longest first, so `Acme Corporation`
  wins over `Acme` and a placeholder is never re-matched by another entry.
- Restoration also works in streaming mode: a placeholder split across several
  SSE deltas is buffered until it can be resolved.
- Placeholders are matched back exactly (case-sensitive). Pick distinctive ones
  such as `__ORG_1__` so ordinary model output cannot collide with them.
- The model does not know what a placeholder stands for. It will reason about
  `__ORG_1__` as an opaque token, which is the point — but it also means the
  model cannot use any knowledge tied to the hidden keyword.
- Entries with a duplicate `from`, a duplicate `to`, or `from` equal to `to` are
  skipped with a warning, because they could not be restored unambiguously.

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-sonnet-5",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start as a Service

> **Applying code changes:** the service runs the compiled `dist/` output, not
> the TypeScript sources. After editing anything under `src/`, rebuild and
> restart or the change will not take effect:
>
> ```bash
> npm run build
> systemctl --user restart claude-max-api-proxy.service   # Linux
> # or on macOS:
> launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy
> ```

### Linux (systemd user service)

The proxy can run as a systemd **user** service (no root required) on port 3456.

**Unit file:** [`deploy/claude-max-api-proxy.service`](deploy/claude-max-api-proxy.service)

```bash
# 1. Build first
npm run build

# 2. Create log directory
mkdir -p ~/.openclaw/logs

# 3. Edit the unit: set WorkingDirectory, PATH, CLAUDE_BIN, and ExecStart
#    to match your clone path and `which node` / `which claude`
cp deploy/claude-max-api-proxy.service ~/.config/systemd/user/
# then edit ~/.config/systemd/user/claude-max-api-proxy.service

# 4. Enable + start
systemctl --user daemon-reload
systemctl --user enable --now claude-max-api-proxy.service

# Status / restart / stop / logs
systemctl --user status claude-max-api-proxy.service
systemctl --user restart claude-max-api-proxy.service
systemctl --user stop claude-max-api-proxy.service
journalctl --user -u claude-max-api-proxy.service -f
# File logs (if configured in the unit):
#   ~/.openclaw/logs/claude-max-proxy.log
#   ~/.openclaw/logs/claude-max-proxy.err.log
```

Optional: keep the user service running after logout:

```bash
sudo loginctl enable-linger "$USER"
```

`HOST=0.0.0.0` in the unit binds on all interfaces (useful for LAN clients). Override with `HOST=127.0.0.1` for localhost-only.

### macOS (LaunchAgent)

The proxy can also run as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess + OpenClaw tool mapping
├── dictionary/
│   ├── replacer.ts        # Single-pass + streaming keyword replacement
│   ├── dictionary.ts      # Dictionary parsing and redact/restore API
│   └── loader.ts          # Dictionary file loading with reload-on-change
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation
- Optional keyword dictionary keeps chosen terms out of outbound prompts

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

```bash
npm run build
npm run test:unit   # fast, offline: dictionary + HTTP layer against a stub CLI
npm run test:e2e    # hits the real Claude CLI and spends Max subscription tokens
```

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
