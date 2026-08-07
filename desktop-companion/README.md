# InterviewCopilot Desktop Companion

Small native utility (Tauri 2 + Rust) that hands **Zoom Desktop / system output audio**
to the existing InterviewCopilot web app over an authenticated localhost bridge.

It does **not** transcribe, generate answers, retrieve resumes, detect questions,
bill anything, or hold any platform secret. Deepgram / OpenAI / Supabase stay in
the web app. The only credential the companion ever sees is the short-lived,
session-scoped **bridge token** released after you approve a pairing code.

## Protocol (matches the existing web bridge client exactly)

`GET http://127.0.0.1:8765/health`

```json
{ "status": "ok", "app": "interviewcopilot-companion", "version": "0.1.0",
  "os": "windows", "platform": "windows", "captureBackend": "wasapi",
  "captureState": "paired", "protocolVersion": 1 }
```

`ws://127.0.0.1:8765/bridge`

| Browser → companion | Companion → browser |
| --- | --- |
| `{ "type": "auth", "token": "…" }` (also accepts `pair`/`bridgeToken`) | `auth_ok`, `paired` |
| `{ "type": "start_capture", "target": "zoom"\|"system", "sampleRate": 16000 }` | `capture_started`, `format`, `state` |
| `stop_capture`, `pause_capture`, `resume_capture` | `capture_stopped`, `state` |
| `get_status`, `ping` | `status`, `pong` |
| — | `level` **and** `audio_level` (`{ level: 0..1 }`, ~5 Hz) |
| — | binary frames: **16 kHz mono signed 16-bit LE PCM, 40 ms (1280 bytes) per packet** |

`level` is what `companion-client.ts` listens for; `audio_level` is emitted
alongside it for the protocol spec. No web-side change was required.

## Security

- Bridge binds to `127.0.0.1` only (ports 8765 → 8766 → 8767 fallback).
- WebSocket upgrades are rejected unless the `Origin` header is the production
  app, an `https://*.lovable.app` preview, or `COMPANION_DEV_ORIGIN`.
- No capture starts before authentication **and** an explicit `start_capture`.
- Bridge token compared in constant time; invalid after the session ends.
- If the authorised browser socket disappears, capture stops after an 8 s grace period.
- Logs never contain tokens, secrets, transcripts, resume data or PCM.

## Layout

```
desktop-companion/
  src/                     tiny UI (index.html, main.js, styles.css)
  src-tauri/src/
    main.rs                tauri app, commands, tray
    bridge/mod.rs          /health + /bridge, origin + token checks
    audio/mod.rs           worker: downmix → resample → linear16 → bridge
    audio/resample.rs      rubato streaming resampler, RMS level
    platform/mod.rs        AudioCaptureBackend trait (all cfg(target_os) lives here)
    platform/windows.rs    WASAPI loopback + Zoom process detection
    platform/macos.rs      ScreenCaptureKit application/system audio (Zoom: us.zoom.xos)
    state.rs               single authoritative capture state machine
    security.rs            origin allow-list + bridge token validation
    logging.rs             structured rolling JSON logs
```

Real-time safety: the WASAPI thread only decodes samples and does one
`try_send` into a bounded (64-slot) channel; drops are counted and surfaced as
`audioBufferDrops`. All resampling/serialisation happens on the worker thread.

## Build (Windows first)

Prerequisites: Rust stable (MSVC toolchain), WebView2 (ships with Win 10/11),
`cargo install tauri-cli --version "^2"`.

```powershell
cd desktop-companion\src-tauri
$env:COMPANION_DEV_ORIGIN = "http://localhost:8080"   # only for local web dev
cargo tauri dev
# installer:
cargo tauri build          # -> target\release\bundle\nsis\*.exe and msi\*.msi
```

## Development build mode (readable native diagnostics)

Enabled by any of: a debug build, `--features dev-diagnostics`, or
`COMPANION_DEV_DIAG=1`. It turns on a wide human-readable console layer
(target, file:line, thread), raises the default filter to
`interviewcopilot_companion=trace`, prints a startup banner with OS /
capture backend / profile, and logs a **native audio heartbeat** every 2 s with
level, packets, bytes, frames, buffer drops, native rate/channels and pause
state. `COMPANION_LOG` still overrides the filter. Nothing sensitive is logged.

```powershell
cargo tauri build --features dev-diagnostics
$env:COMPANION_DEV_DIAG = "1"; .\interviewcopilot-companion.exe
```

## CI build validation

`.github/workflows/companion-windows.yml` runs **only** on `desktop-companion/`,
on `windows-latest`, and does source validation → Windows compilation →
bundling → artifact. It never opens an audio device.

All cargo commands run from `desktop-companion/src-tauri` (the Cargo manifest
*and* Tauri project root; the workflow fails fast if either file is missing).

1. stable MSVC toolchain, `rustup target add x86_64-pc-windows-msvc`, prints
   `rustc --version` / `cargo --version` / `rustup show active-toolchain`
2. `cargo install tauri-cli --version 2.9.1 --locked`, prints `cargo tauri --version`
3. `cargo fmt --check` → `cargo check --all-targets --target … --features
   require-native-backend,dev-diagnostics` → clippy (non-blocking)
4. resolved versions from `cargo metadata`/`cargo tree`: tauri, tauri-build,
   wasapi, rubato, windows, axum
5. **backend proof**: `cargo test platform::tests` asserts the Windows build
   selected the WASAPI backend, and the `require-native-backend` feature makes
   the `Unsupported` stub a `compile_error!`. A `wasapi` entry in `Cargo.lock`
   alone is not accepted as proof.
6. `cargo tauri build --target x86_64-pc-windows-msvc --features
   require-native-backend,dev-diagnostics`, then greps the build log for
   `build.rs` markers (`target_os=windows`, `capture_backend=wasapi`,
   `feature_dev_diagnostics=enabled`) so an enabled feature is verified at
   rustc level, not in the command string.
7. **BUILD OUTPUTS**: discovers the real target dir and prints executable /
   NSIS installer / MSI installer paths, or `not generated`. A missing MSI (WiX
   or VBScript tooling on the runner) is reported, not fatal — a missing `.exe`
   is fatal. Genuine Rust compilation failures are never suppressed.

Artifacts upload as `interviewcopilot-companion-windows`. No release, no
signing certificate.



## Verification status (honest)

- Windows and macOS code is written but **has not been compiled or run here** —
  this sandbox has no Rust toolchain and no Windows/macOS audio stack. Nothing
  is claimed as validated, and no installer is distributable yet.
- macOS native capture is **not implemented**; `start` returns an explicit error
  so the web app falls back to browser tab audio rather than faking success.
- Windows Zoom **per-process** capture is not implemented yet: with
  `target: "zoom"` the companion captures system output loopback and reports
  `captureMethod: "WASAPI SYSTEM LOOPBACK"` — it never labels itself Zoom-only.
  Zoom process detection (`zoom_detected` / `zoom_not_detected`) does run.

## Acceptance tests to run on a real Windows machine

1. **System audio** — launch companion → *Local audio test* → play any audio.
   Level meter must move, `packetsSent` must climb, level falls on silence,
   *Stop* releases the device.
2. **Zoom** — pair with the web app (code from the Zoom Desktop panel) →
   *Start Zoom Audio* → remote participant speaks → browser companion meter
   moves → remote Deepgram becomes active → INTERVIEWER transcript → one
   question → resume retrieval → streamed answer.
3. **Echo** — candidate answers aloud; the browser's existing echo suppression
   must drop the loopback duplicate (`echo drops` increments in Diagnostics) and
   must not produce a second question.
