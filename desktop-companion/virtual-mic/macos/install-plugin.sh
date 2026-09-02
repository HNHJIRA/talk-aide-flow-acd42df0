#!/bin/bash
# Installs the InterviewCopilot CoreAudio virtual device (needs admin).
# Non-fatal by design: if this fails the Companion falls back to browser playback.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")" && pwd)/InterviewCopilotAudio.driver}"
DEST="/Library/Audio/Plug-Ins/HAL"

if [ ! -d "$SRC" ]; then
  echo "Driver bundle not found at $SRC" >&2
  exit 1
fi

echo "Installing InterviewCopilot Virtual Microphone…"
sudo mkdir -p "$DEST"
sudo rm -rf "$DEST/InterviewCopilotAudio.driver"
sudo cp -R "$SRC" "$DEST/"
sudo chown -R root:wheel "$DEST/InterviewCopilotAudio.driver"

echo "Restarting CoreAudio…"
sudo killall coreaudiod || true

echo "Done. 'InterviewCopilot Virtual Microphone' should now appear in System Settings → Sound → Input."
