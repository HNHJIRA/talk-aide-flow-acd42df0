; NSIS hooks for the Tauri Windows installer.
; Wire up in tauri.conf.json:
;   "bundle": { "windows": { "nsis": {
;      "installerHooks": "../virtual-mic/windows/installer-hook.nsh",
;      "resources": { "../virtual-mic/windows/": "virtual-mic/" } } } }
;
; Failure to install the driver is non-fatal: the Companion detects its
; absence and falls back to browser playback.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing InterviewCopilot Virtual Microphone..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\virtual-mic\install-driver.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Virtual microphone install skipped (code $0). InterviewCopilot will use browser playback."
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\virtual-mic\uninstall-driver.ps1"'
  Pop $0
!macroend
