# InterviewCopilot Virtual Microphone (Phase 2)

Goal: the user installs **only** the InterviewCopilot Companion, and Zoom /
Teams / Google Meet see an input device named:

```
InterviewCopilot Virtual Microphone
```

No VB-CABLE, BlackHole or Loopback.

## How it fits the existing pipeline (nothing else changes)

```
Candidate speaks
  → existing STT (unchanged)
  → existing translation (unchanged)
  → existing TTS (unchanged)
  → browser: decode to 16 kHz mono PCM16
  → binary WS frames → companion bridge
  → ic-audio-output worker (Phase 1, unchanged)
  → AudioOutputRouter renders into "InterviewCopilot Virtual Audio" (render endpoint)
  → driver loops render → capture
  → "InterviewCopilot Virtual Microphone" (capture endpoint)
  → Zoom / Teams / Meet select it as their microphone
```

Meeting capture (WASAPI loopback / ScreenCaptureKit), Deepgram STT,
diarization, turn assembly, question detection, AI answers and the overlay are
untouched — this layer only adds a render target plus detection/diagnostics.

Companion-side integration already implemented:

* `src-tauri/src/audio/output/virtual_mic.rs` — branded-name detection,
  install-marker check, device-id resolution (`interviewcopilot-virtual-mic`),
  level metering and the health snapshot.
* `src-tauri/src/audio/output/mod.rs` — the worker resolves the branded device
  on `Open` and meters every rendered buffer.
* `src-tauri/src/bridge/mod.rs` — `virtual_mic_status` command (read-only).
* Web: `native-output-client.ts`, `useInterpreterOutput.ts` and the
  **Virtual Mic** block in `InterpreterOutputDiagnostics.tsx`
  (installed / active / device name / connected app / level / latency / dropped).

If the driver is missing, `installed = false`, the router falls back to the
system default device, and the browser `<audio>` playback fallback stays fully
functional — both the interpreter and the meeting copilot keep working.

## 1. Windows implementation plan

Architecture: a **user-mode-installable APO-free virtual audio driver** built
on the WDK `SysVAD` sample (Audio class driver, `PortCls`), trimmed to one
render endpoint and one capture endpoint wired together by an internal ring
buffer.

* Driver name/binary: `icvad.sys`, hardware id `ROOT\InterviewCopilotAudio`.
* Endpoints published by `icvad.inf`:
  * Render: `InterviewCopilot Virtual Audio`
  * Capture: `InterviewCopilot Virtual Microphone`
* Format: 48 kHz, 16-bit, mono + stereo mix formats (the worker resamples
  16 kHz TTS → device rate; already implemented in `render.rs`).
* Loopback: render engine writes into a lock-free ring buffer read by the
  capture engine on the capture DPC, with drift correction against the capture
  clock and silence fill on underrun.
* Signing: EV code-signing certificate + Microsoft **Hardware Dev Center**
  attestation signing (required for Windows 10/11 to load the driver).
* Install: `pnputil /add-driver icvad.inf /install` from an elevated context.

Files in `windows/`:

* `icvad.inf` — INF publishing the two endpoints and the friendly names.
* `install-driver.ps1` / `uninstall-driver.ps1` — elevated install/removal.
* `BUILD.md` — WDK build + attestation-signing steps (must run on Windows).

## 2. macOS implementation plan

Architecture: a **CoreAudio AudioServerPlugIn** (user-space HAL plugin, no
kernel extension, no DriverKit needed) exposing one device with an output
stream and an input stream connected by a ring buffer.

* Bundle: `/Library/Audio/Plug-Ins/HAL/InterviewCopilotAudio.driver`
* Device name: `InterviewCopilot Virtual Microphone`
* Format: 48 kHz Float32, 2 ch (mono TTS is upmixed by the driver).
* Loading: `coreaudiod` loads HAL plugins at start —
  `sudo killall coreaudiod` after install (or reboot).
* Signing/notarization: Developer ID Application signature, hardened runtime,
  then notarize the enclosing `.pkg` (`notarytool submit --wait`, `stapler`).
  A HAL plugin needs no user permission prompt itself, but the Companion still
  needs Microphone permission for candidate capture (already granted today).

Files in `macos/`:

* `install-plugin.sh` / `uninstall-plugin.sh`
* `BUILD.md` — Xcode project layout, signing and notarization commands
  (must run on macOS with Xcode + a Developer ID).

## 3. Installer changes

Windows (NSIS bundle):

* Ship `icvad.sys`, `icvad.inf`, `icvad.cat` as bundle resources.
* Add the NSIS install hook `windows/installer-hook.nsh` to
  `tauri.conf.json → bundle.windows.nsis.installerHooks`; it runs
  `pnputil /add-driver` on install and `/delete-driver` on uninstall.

macOS (`.pkg` bundle):

* Ship the `.driver` bundle as a resource and run
  `macos/postinstall` from the pkg scripts to copy it into
  `/Library/Audio/Plug-Ins/HAL` and restart `coreaudiod`.
* Sign + notarize the pkg; the driver bundle is signed separately.

Both installers are optional at runtime: the Companion detects absence and
reports it in diagnostics instead of failing.

## 4. Testing steps

1. Install the Companion; confirm diagnostics shows `Virtual Mic: installed`.
2. Windows: `Sound settings → Input` lists *InterviewCopilot Virtual
   Microphone*. macOS: it appears in *System Settings → Sound → Input*.
3. Start a session, enable Voice Interpreter and native output; speak.
   The Virtual Mic level bar must move while the meeting latency metrics stay
   unchanged.
4. In Zoom / Teams / Meet select *InterviewCopilot Virtual Microphone* as the
   microphone and confirm the other side hears the translated voice.
5. Regression: interviewer speaks → transcript, question detection and AI
   answer must behave exactly as before (same latency waterfall numbers).
6. Kill the driver (`pnputil /delete-driver`, or remove the HAL plugin +
   `killall coreaudiod`): interpreter falls back to browser playback and the
   copilot keeps working.

## 5. Known OS restrictions

* Windows requires a signed (attestation or WHQL) driver; unsigned builds only
  load with test-signing enabled and a reboot.
* Driver install always requires elevation and may require a reboot before the
  endpoint appears.
* macOS HAL plugins require admin rights to write to `/Library/Audio/Plug-Ins/HAL`
  and a `coreaudiod` restart; apps already running may not see the device until
  they are relaunched.
* macOS distribution outside the App Store requires Developer ID + notarization;
  the Mac App Store does not allow HAL plugins.
* Neither OS reports "which app is using an input device" through a public API;
  the *Connected application* diagnostic is best-effort and shows `—` when the
  OS does not expose it.
* Browsers (Google Meet, Teams Web) also require the user to pick the device in
  the site's microphone settings — the OS default alone is not enough.
