#!/bin/bash
# InterviewCopilot Mac Companion - launch + local bridge health check.
# Run this AFTER BUILD-MAC-COMPANION.command succeeded.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/desktop-companion/src-tauri"
TARGET="aarch64-apple-darwin"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
red()  { printf "\033[1;31m%s\033[0m\n" "$*"; }
grn()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
yel()  { printf "\033[1;33m%s\033[0m\n" "$*"; }
line() { printf "%s\n" "------------------------------------------------------------"; }

hold_open() {
  echo
  line
  echo "Press RETURN to close this window."
  read -r _
}

clear
bold "=============================================================="
bold "  INTERVIEWCOPILOT MAC COMPANION - LAUNCH & HEALTH TEST"
bold "=============================================================="

APP_PATH="$(find "$TAURI_DIR/target/$TARGET/release/bundle" "$TAURI_DIR/target/release/bundle" \
  -maxdepth 3 -name '*.app' -print -quit 2>/dev/null || true)"

if [ -z "$APP_PATH" ]; then
  red "No built companion (.app) found."
  echo "Run BUILD-MAC-COMPANION.command first, then rerun this test."
  hold_open
  exit 1
fi

echo "Found app : $APP_PATH"
echo "Launching..."
open "$APP_PATH" || { red "Failed to launch the app."; hold_open; exit 1; }

echo "Waiting for the local bridge to come up..."
HEALTH=""
PORT_OK=""
for i in $(seq 1 20); do
  for PORT in 8765 8766 8767; do
    BODY="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    if [ -n "$BODY" ]; then HEALTH="$BODY"; PORT_OK="$PORT"; break; fi
  done
  [ -n "$HEALTH" ] && break
  sleep 1
done

line
if [ -z "$HEALTH" ]; then
  red "NO RESPONSE from http://127.0.0.1:8765/health (also tried 8766, 8767)."
  echo
  echo "Things to check:"
  echo "  - Is the companion window actually open? (check the menu bar tray icon)"
  echo "  - Did macOS block the unsigned app? Right-click the .app > Open, allow it,"
  echo "    or System Settings > Privacy & Security > 'Open Anyway'."
  echo "  - Another process may already own port 8765."
  hold_open
  exit 1
fi

grn "BRIDGE HEALTH OK on port $PORT_OK"
echo
if command -v python3 >/dev/null 2>&1; then
  echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
else
  echo "$HEALTH"
fi
line

bold "PERMISSIONS"
echo "macOS must grant the companion 'Screen & System Audio Recording'."
echo "If you have not been prompted, or capture fails, open:"
echo "  System Settings > Privacy & Security > Screen & System Audio Recording"
echo "and enable InterviewCopilot Companion, then quit and relaunch the app."
echo
bold "WHAT TO DO NEXT - IN THIS ORDER"
echo "  1. In the companion window, run the SYSTEM AUDIO TEST while any audio plays."
echo "     The level meter must move and packetsSent must climb."
echo "  2. Only if step 1 shows real levels/packets, pair with the InterviewCopilot"
echo "     web app (Zoom Desktop panel) and verify the bridge connects."
echo "  3. Only then test real Zoom Desktop audio -> Deepgram -> INTERVIEWER"
echo "     -> question detection -> resume retrieval -> streamed answer."
echo
yel "A healthy /health response only proves the app launched and the local bridge"
yel "is listening. It does NOT prove Zoom or system audio capture works."

hold_open
