# Backend — AdMob Mediation agent

The reasoning service, built on **Google's Agent Development Kit (ADK)** (PyPI
`google-adk`) with **Gemini 3.5 Flash** as the model. FastAPI exposes the agent to
the Chrome extension; the agent emits semantic *intents* (highlight / click / draft
/ propose-save) that the extension executes on the page — it never touches the DOM
itself.

## Run

```bash
uv sync
./run.sh          # serves http://127.0.0.1:8765  (GET /healthz to check)
```

Requires `GEMINI_API_KEY` in `../.env` (gitignored). Smoke-test the agent without
HTTP: `uv run python -m app.smoke`.

## Layout

| File | Purpose |
|------|---------|
| `app/agent.py` | ADK `LlmAgent`, the five tools, and the system instruction |
| `app/server.py` | FastAPI: `/healthz`, `/api/chat`, `/api/chat/stream` (SSE); the `_run_turn` engine |
| `app/schemas.py` | Pydantic wire contract (mirrors the extension's `protocol.ts`) |
| `app/knowledge.py` | AdMob mediation knowledge base + create-flow steps |
| `app/smoke.py` | Direct (no-HTTP) agent smoke test |

Design: [`../docs/09-design.md`](../docs/09-design.md) §4–5.
