# InterviewCopilot Virtual Microphone — macOS (CoreAudio AudioServerPlugIn)

A native virtual audio device published by a userspace CoreAudio driver
(AudioServerPlugIn — no kext, no third-party cable). Users need neither
BlackHole, VB-CABLE nor Loopback.

Device name (exact, must match the Companion's detection string):

```
InterviewCopilot Virtual Microphone
```

## What it does

```
Interpreter TTS (browser)
        ↓ binary PCM (WebSocket)
Companion  audio/output/render.rs   (cpal → CoreAudio)
        ↓ renders into the device's OUTPUT stream
InterviewCopilotAudio.driver  → lock-free ring buffer (sample-time keyed)
        ↓ device's INPUT stream
Zoom / Microsoft Teams / Google Meet / Chrome microphone selector
```

Format: 48 kHz, mono, Float32 (the HAL mix format). Clients requesting
16-bit PCM are converted transparently by CoreAudio. The ring is 65 536
frames (~1.36 s); read slots are zeroed after consumption so a stalled
writer produces silence, never looped audio.

## Files

| File | Purpose |
| --- | --- |
| `src/InterviewCopilotAudio.c` | Full AudioServerPlugIn: plug-in/box/device/stream objects, property table, IO cycle, ring-buffer loopback |
| `Info.plist` | `CFPlugInFactories` / `CFPlugInTypes` wiring `ICA_Create` to `kAudioServerPlugInTypeUUID` |
| `build-driver.sh` | Universal (arm64 + x86_64) bundle build, optional codesign |
| `install-plugin.sh` | Copies the bundle to `/Library/Audio/Plug-Ins/HAL`, fixes ownership, restarts coreaudiod |
| `uninstall-plugin.sh` | Removes it and restarts coreaudiod |
| `postinstall` | Same install step, run from the Companion `.pkg` |

## Build requirements

- macOS 11 or newer
- Xcode command line tools (`xcode-select --install`)
- For distribution: an Apple Developer ID Application certificate, an
  Developer ID Installer certificate, and `notarytool` credentials.

```bash
cd desktop-companion/virtual-mic/macos
./build-driver.sh                     # → build/InterviewCopilotAudio.driver
```

## Local development install

```bash
./install-plugin.sh build/InterviewCopilotAudio.driver
```

The script copies the bundle to `/Library/Audio/Plug-Ins/HAL`, sets
`root:wheel`, and runs `sudo killall coreaudiod`. Audio drops out for about
a second while CoreAudio restarts — that is expected.

Verify:

1. `system_profiler SPAudioDataType | grep -A3 InterviewCopilot`
2. **System Settings → Sound → Input** shows
   *InterviewCopilot Virtual Microphone*.
3. **Audio MIDI Setup** (`/Applications/Utilities`) lists the device with
   1 in / 1 out at 48 000 Hz.
4. Play into it: `Audio MIDI Setup → set it as output`, then watch the input
   level meter move.
5. Companion → Interpreter Output Diagnostics shows
   *Virtual Mic: installed / active* with a moving level.

Uninstall: `./uninstall-plugin.sh`.

If the device does not appear, check `log show --last 2m --predicate
'subsystem == "com.apple.coreaudio"' | grep -i interviewcopilot` — an
unloadable bundle (bad Info.plist UUIDs, wrong architecture, quarantine
flag) is reported there. Remove quarantine with
`sudo xattr -dr com.apple.quarantine /Library/Audio/Plug-Ins/HAL/InterviewCopilotAudio.driver`.

## Signing, hardened runtime, notarization

macOS security is respected, never bypassed — no SIP disabling, no kext.

```bash
CODESIGN_ID="Developer ID Application: <Team> (<TEAMID>)" ./build-driver.sh

pkgbuild --root build \
  --identifier com.interviewcopilot.virtualmic.pkg \
  --version 1.0.0 \
  --install-location /Library/Audio/Plug-Ins/HAL \
  --scripts . \
  --sign "Developer ID Installer: <Team> (<TEAMID>)" \
  InterviewCopilotVirtualMic.pkg

xcrun notarytool submit InterviewCopilotVirtualMic.pkg \
  --keychain-profile "ic-notary" --wait
xcrun stapler staple InterviewCopilotVirtualMic.pkg
```

Notes:

- The plug-in binary is signed with `--options runtime` (hardened runtime).
- `coreaudiod` loads only bundles owned by `root:wheel` in
  `/Library/Audio/Plug-Ins/HAL`; installation therefore requires admin
  authorization (the `.pkg` prompts once).
- The Companion app itself needs the microphone entitlement only for its own
  capture; this driver requires no TCC permission.

## Known OS restrictions

- Installing/removing the plug-in restarts `coreaudiod`, briefly interrupting
  all audio on the machine.
- The device is fixed at 48 kHz mono by design; format negotiation is
  declined (`kAudioHardwareUnsupportedOperationError`).
- macOS caches the HAL plug-in list; after an upgrade the user may need to
  log out or run `sudo killall coreaudiod` again.
- Meeting apps enumerate microphones at launch — Zoom/Teams may need a
  restart to show the device the first time.
