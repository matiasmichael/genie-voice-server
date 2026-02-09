# CLAUDE.md

## Project Overview

Genie Voice Server is a real-time voice conversation API that bridges **Twilio** phone calls with the **OpenAI Realtime API** (GPT-4o). Callers have natural voice conversations with an AI assistant named "Genie." The entire application lives in a single `server.js` file (pure JavaScript, ES modules).

## Architecture

```
HTTP Server (Express on port 3000)
├── GET  /             → Dashboard UI (inline HTML/CSS/JS)
├── GET  /api/logs     → JSON call log endpoint
├── ALL  /voice        → TwiML XML response for Twilio webhooks
└── GET  /health       → Health check ("OK")

WebSocket Server (ws library)
└── /media-stream      → Bidirectional audio bridge
    ├── Twilio side: receives G.711 u-law audio from phone
    └── OpenAI side: proxies audio to/from OpenAI Realtime API
```

**Audio flow:** Phone caller → Twilio → WebSocket `/media-stream` → OpenAI Realtime API → WebSocket → Twilio → Phone caller

Key implementation details:
- Audio codec: G.711 u-law (required by Twilio)
- Voice activity detection: server-side VAD (managed by OpenAI)
- Response modalities: `['text', 'audio']` — both must be included for audio output to work
- Voice model: "shimmer"
- Temperature: 0.8
- In-memory circular log buffer (max 100 entries, lost on restart)

## File Structure

```
├── server.js           # Entire application (single file, ~323 lines)
├── package.json        # Dependencies and start script
├── package-lock.json   # Locked dependency versions
├── render.yaml         # Render.com deployment configuration
├── .gitignore          # Ignores node_modules
└── CLAUDE.md           # This file
```

## Commands

- **Install dependencies:** `npm install`
- **Start server:** `npm start` (runs `node server.js`)
- **No build step** — plain JavaScript, no transpilation
- **No test framework** — no tests exist
- **No linter** — no ESLint/Prettier configured

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for Realtime API auth |
| `PORT` | No | `3000` | HTTP server listen port |

## Dependencies

Only two production dependencies (no dev dependencies):
- **express** (`^4.18.2`) — HTTP server and routing
- **ws** (`^8.16.0`) — WebSocket server (Twilio) and client (OpenAI)

## Code Conventions

- **ES modules** (`"type": "module"` in package.json) — use `import`, not `require`
- **Constants:** `UPPER_SNAKE_CASE` (e.g., `OPENAI_API_KEY`, `SYSTEM_MESSAGE`, `VOICE`)
- **Variables/functions:** `camelCase` (e.g., `streamSid`, `addLog`, `initializeSession`)
- **Strings:** single quotes for code, backticks for templates
- **Indentation:** 2 spaces
- **No semicolons rule:** semicolons are used consistently
- **Error handling:** try-catch around message parsing, errors logged via `addLog('error', ...)`
- **WebSocket safety:** always check `readyState === WebSocket.OPEN` before sending

## Deployment

Deployed on **Render.com** (configured in `render.yaml`):
- Runtime: Node.js
- Build: `npm install`
- Start: `node server.js`
- Requires `OPENAI_API_KEY` environment variable set in Render dashboard

## Key Patterns and Pitfalls

1. **Modalities must include both text and audio** — using `['audio']` alone breaks audio output. Always use `['text', 'audio']` in both `session.update` and `response.create`.
2. **Session initialization is delayed** — `initializeSession` runs 100ms after OpenAI WebSocket opens; initial greeting fires 300ms after that. These timeouts ensure the connection is ready.
3. **No persistent storage** — all logs are in-memory and lost on server restart.
4. **Single-file architecture** — all logic is in `server.js`. There are no modules, utilities, or separate route files.
5. **Dashboard is inline HTML** — the entire dashboard UI is a template literal inside the `GET /` handler. There are no static files.
