#!/usr/bin/env bash
# Start the AdMob agent backend on 127.0.0.1:8765
set -euo pipefail
cd "$(dirname "$0")"
exec uv run uvicorn app.server:app --host 127.0.0.1 --port 8765 "$@"
