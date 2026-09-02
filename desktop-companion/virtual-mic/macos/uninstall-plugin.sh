#!/bin/bash
# Removes the InterviewCopilot CoreAudio virtual device (needs admin).
set -euo pipefail
sudo rm -rf "/Library/Audio/Plug-Ins/HAL/InterviewCopilotAudio.driver"
sudo killall coreaudiod || true
echo "InterviewCopilot Virtual Microphone removed."
