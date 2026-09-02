#!/bin/bash
# Builds the InterviewCopilot Virtual Microphone AudioServerPlugIn bundle.
#
#   ./build-driver.sh                # unsigned local build (dev)
#   CODESIGN_ID="Developer ID Application: Acme (TEAMID)" ./build-driver.sh
#
# Output: ./build/InterviewCopilotAudio.driver
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
BUNDLE="$BUILD/InterviewCopilotAudio.driver"
ARCHS="${ARCHS:--arch arm64 -arch x86_64}"
MIN_MACOS="${MIN_MACOS:-11.0}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This driver can only be built on macOS with Xcode command line tools." >&2
  exit 1
fi

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

echo "Compiling AudioServerPlugIn…"
# shellcheck disable=SC2086
clang $ARCHS \
  -mmacosx-version-min="$MIN_MACOS" \
  -bundle \
  -O2 -Wall -Wextra -fvisibility=hidden \
  -framework CoreAudio -framework CoreFoundation \
  -o "$BUNDLE/Contents/MacOS/InterviewCopilotAudio" \
  "$HERE/src/InterviewCopilotAudio.c"

cp "$HERE/Info.plist" "$BUNDLE/Contents/Info.plist"

if [ -n "${CODESIGN_ID:-}" ]; then
  echo "Signing with $CODESIGN_ID…"
  codesign --force --options runtime --timestamp \
    --sign "$CODESIGN_ID" "$BUNDLE"
  codesign --verify --strict --verbose=2 "$BUNDLE"
else
  echo "NOTE: unsigned build. macOS will load it locally, but distribution"
  echo "      requires Developer ID signing + notarization (see BUILD.md)."
fi

echo "Built: $BUNDLE"
