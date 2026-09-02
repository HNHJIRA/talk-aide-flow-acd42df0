# Building the macOS virtual audio device (InterviewCopilotAudio.driver)

Must run on macOS with Xcode and a Developer ID — this repo carries only the
packaging/detection glue.

## Type
A **CoreAudio AudioServerPlugIn** (user-space HAL plugin). No kernel extension,
no DriverKit entitlement request, no user permission prompt for the device
itself.

## Steps
1. New Xcode target: Bundle, extension `.driver`, `Info.plist` with
   `CFPlugInFactories` → `AudioServerPlugInDriverFactory`.
2. Implement `AudioServerPlugInDriverInterface` for one device:
   * device name `InterviewCopilot Virtual Microphone`
   * manufacturer `InterviewCopilot`
   * output stream + input stream, 48 kHz Float32, 2 ch
   * a ring buffer written by the output stream's `DoIOOperation`
     (`kAudioServerPlugInIOOperationWriteMix`) and read by the input stream's
     `ReadInput`, with a zero-fill on underrun and host-clock-based timestamps.
3. Signing (hardened runtime, Developer ID Application):
   ```
   codesign --force --options runtime --timestamp \
     --sign "Developer ID Application: <TEAM>" InterviewCopilotAudio.driver
   ```
4. Ship it inside the app bundle at
   `Contents/Resources/virtual-mic/InterviewCopilotAudio.driver` and install it
   with the pkg `postinstall` script in this folder.
5. Notarize the distributed pkg:
   ```
   xcrun notarytool submit InterviewCopilot.pkg --keychain-profile IC --wait
   xcrun stapler staple InterviewCopilot.pkg
   ```

## Verifying
```
system_profiler SPAudioDataType | grep -A3 InterviewCopilot
```
Then the Companion diagnostics must show `Virtual Mic: installed`.

## Restrictions
* `/Library/Audio/Plug-Ins/HAL` requires admin rights.
* `coreaudiod` must be restarted (or the Mac rebooted) before the device is
  visible; already-running apps may need a relaunch to list it.
* Mac App Store distribution is not possible for HAL plugins.
