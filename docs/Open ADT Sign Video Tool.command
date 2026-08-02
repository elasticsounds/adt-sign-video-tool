#!/bin/zsh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$((8600 + ($$ % 300)))
URL="http://127.0.0.1:${PORT}/"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ADT Sign Video Tool needs Python 3 to start its local web address."
  echo ""
  echo "Install Python 3 from https://www.python.org/downloads/ and run this launcher again."
  echo ""
  read "REPLY?Press Return to close…"
  exit 1
fi

echo "Starting ADT Sign Video Tool…"
echo "The tool will open at: ${URL}"
echo ""
echo "Keep this Terminal window open while using the tool."
echo "Close this window or press Control-C when you are finished."
echo ""

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SCRIPT_DIR" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep 1
open "$URL"
wait "$SERVER_PID"
