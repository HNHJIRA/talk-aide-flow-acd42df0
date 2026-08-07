#!/bin/bash
# InterviewCopilot Mac Companion - one-click local builder (Apple Silicon first)
# Double-click this file in Finder. No Git, no manual terminal steps.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/desktop-companion/src-tauri"
TARGET="aarch64-apple-darwin"
FEATURES="require-native-backend,dev-diagnostics"
LOG="$SCRIPT_DIR/mac-companion-build.log"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
red()  { printf "\033[1;31m%s\033[0m\n" "$*"; }
grn()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
yel()  { printf "\033[1;33m%s\033[0m\n" "$*"; }
line() { printf "%s\n" "------------------------------------------------------------"; }

hold_open() {
  echo
  line
  echo "This window stays open so you can read/copy the output above."
  echo "Full log saved to: $LOG"
  echo "Press RETURN to close."
  read -r _
}

fail() {
  echo
  red "=============================================================="
  red "  BUILD FAILED"
  red "=============================================================="
  echo
  echo "$1"
  hold_open
  exit 1
}

# Mirror everything to a log file we can point at on failure.
exec > >(tee "$LOG") 2>&1

clear
bold "=============================================================="
bold "  INTERVIEWCOPILOT MAC COMPANION - ONE CLICK BUILDER"
bold "=============================================================="
echo "Project folder : $SCRIPT_DIR"
echo "Tauri project  : $TAURI_DIR"
echo "Target         : $TARGET (Apple Silicon)"
echo "Features       : $FEATURES"
line

# ---------------------------------------------------------------- 0. layout
[ -f "$TAURI_DIR/Cargo.toml" ] || fail "Could not find desktop-companion/src-tauri/Cargo.toml next to this script.
Make sure you extracted the whole project ZIP and double-clicked the .command inside the extracted folder."
[ -f "$TAURI_DIR/tauri.conf.json" ] || fail "Missing desktop-companion/src-tauri/tauri.conf.json."
[ -f "$TAURI_DIR/Info.plist" ] || yel "WARNING: Info.plist not found - Screen & System Audio Recording permission strings may be missing."

# ---------------------------------------------------------------- 1. macOS version
OS_VER="$(sw_vers -productVersion 2>/dev/null || echo 0)"
OS_MAJOR="${OS_VER%%.*}"
echo "macOS version  : $OS_VER"
if [ "${OS_MAJOR:-0}" -lt 13 ]; then
  fail "macOS 13 (Ventura) or newer is required for ScreenCaptureKit system audio capture.
You are running macOS $OS_VER."
fi

# ---------------------------------------------------------------- 2. architecture
ARCH="$(uname -m)"
echo "Architecture   : $ARCH"
if [ "$ARCH" != "arm64" ]; then
  yel "WARNING: This Mac is not Apple Silicon (detected: $ARCH)."
  yel "This builder targets $TARGET first. On Intel the produced binary will"
  yel "not run natively here. Continuing anyway - press Ctrl+C to abort."
  sleep 4
fi
line

# ---------------------------------------------------------------- 3. Xcode CLT
if ! xcode-select -p >/dev/null 2>&1; then
  yel "Xcode Command Line Tools are NOT installed. Launching the Apple installer..."
  xcode-select --install >/dev/null 2>&1 || true
  fail "The macOS 'Command Line Tools' installer has been opened (accept the prompt).
Wait until it finishes installing, then DOUBLE-CLICK BUILD-MAC-COMPANION.command again."
fi
echo "Xcode CLT      : $(xcode-select -p)"

# ---------------------------------------------------------------- 4. Rust
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  yel "Rust (cargo) not found. Installing the official rustup toolchain (non-interactive)..."
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  else
    fail "curl is unavailable, so rustup cannot be installed automatically.
Install Rust from https://rustup.rs then rerun this builder."
  fi
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="$HOME/.cargo/bin:$PATH"
fi
command -v cargo >/dev/null 2>&1 || fail "Rust installed but 'cargo' is still not on PATH.
Close this window, open a new one, and double-click the builder again."

rustup toolchain install stable --profile minimal >/dev/null 2>&1 || true
rustup default stable >/dev/null 2>&1 || true

echo "Ensuring Rust target $TARGET ..."
rustup target add "$TARGET" || fail "Could not add the $TARGET Rust target."

# ---------------------------------------------------------------- 5. Tauri CLI
if ! cargo tauri --version >/dev/null 2>&1; then
  yel "Tauri 2 CLI not found. Installing (this can take several minutes)..."
  cargo install tauri-cli --version "^2" --locked || fail "Failed to install the Tauri 2 CLI."
fi

# ---------------------------------------------------------------- 6. versions
line
bold "TOOLCHAIN VERSIONS"
echo "rustc      : $(rustc --version)"
echo "cargo      : $(cargo --version)"
echo "rustup     : $(rustup show active-toolchain 2>/dev/null | head -1)"
echo "tauri-cli  : $(cargo tauri --version 2>/dev/null | head -1)"
echo "targets    : $(rustup target list --installed | tr '\n' ' ')"
line

cd "$TAURI_DIR" || fail "Could not enter $TAURI_DIR"

# ---------------------------------------------------------------- 7. real cargo check
bold "STEP 1/2 - Compiling the real ScreenCaptureKit backend (cargo check)"
echo "features: $FEATURES  (require-native-backend fails the build if the"
echo "stub/unsupported capture backend is selected)"
echo
if ! cargo check --all-targets --target "$TARGET" --features "$FEATURES"; then
  fail "The native macOS ScreenCaptureKit backend did NOT compile.
The real Rust/Tauri error is printed above (scroll up) and saved in:
  $LOG
Select the text in this window and press Cmd+C to copy it."
fi
grn "ScreenCaptureKit backend compiled."

# Backend proof: this test asserts the selected backend is screencapturekit.
echo
bold "Verifying the selected capture backend..."
cargo test --target "$TARGET" --features "$FEATURES" platform::tests -- --nocapture \
  || yel "Backend unit test did not pass/run cleanly - see output above."

# ---------------------------------------------------------------- 8. release build
line
bold "STEP 2/2 - Building the release app + dmg for $TARGET"
echo "(first build downloads and compiles all crates - grab a coffee)"
echo
if ! cargo tauri build --target "$TARGET" --features "$FEATURES"; then
  fail "The Tauri release build failed.
The real Rust/Tauri error is printed above (scroll up) and saved in:
  $LOG
Select the text in this window and press Cmd+C to copy it."
fi

# ---------------------------------------------------------------- 9. locate outputs
BUNDLE_DIR="$TAURI_DIR/target/$TARGET/release/bundle"
APP_PATH="$(find "$BUNDLE_DIR" -maxdepth 3 -name '*.app' -print -quit 2>/dev/null || true)"
DMG_PATH="$(find "$BUNDLE_DIR" -maxdepth 3 -name '*.dmg' -print -quit 2>/dev/null || true)"

[ -n "$APP_PATH" ] || fail "The build reported success but no .app bundle was found under:
  $BUNDLE_DIR"

echo
grn "=============================================================="
grn "  INTERVIEWCOPILOT MAC COMPANION BUILT SUCCESSFULLY"
grn "=============================================================="
echo
echo ".app : $APP_PATH"
if [ -n "$DMG_PATH" ]; then
  echo ".dmg : $DMG_PATH"
  OPEN_DIR="$(dirname "$DMG_PATH")"
else
  yel "NOTE: no .dmg was produced (the macOS dmg bundler did not run or failed)."
  yel "The .app IS built and fully usable - opening the .app folder instead."
  OPEN_DIR="$(dirname "$APP_PATH")"
fi

echo
bold "NEXT STEPS (nothing about Zoom is proven yet)"
echo "  1. Run TEST-MAC-COMPANION.command to launch the app and check /health."
echo "  2. Grant Screen & System Audio Recording when macOS asks"
echo "     (System Settings > Privacy & Security > Screen & System Audio Recording)."
echo "  3. Run the System Audio Test in the companion window FIRST."
echo "  4. Only after real audio levels/packets appear, test Zoom Desktop."
echo
echo "Opening the output folder in Finder..."
open "$OPEN_DIR" 2>/dev/null || true

hold_open
