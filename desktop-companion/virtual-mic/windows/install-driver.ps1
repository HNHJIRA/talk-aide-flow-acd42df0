# Installs the InterviewCopilot Virtual Microphone driver (elevated).
# Called by the Tauri/NSIS installer hook, and usable standalone for testing.
#Requires -RunAsAdministrator
param(
  [string]$InfPath = (Join-Path $PSScriptRoot 'icvad.inf')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InfPath)) {
  Write-Error "Driver package not found at $InfPath"
}

Write-Host 'Installing InterviewCopilot Virtual Microphone…'
& pnputil.exe /add-driver $InfPath /install
if ($LASTEXITCODE -ne 0) {
  Write-Error "pnputil failed with exit code $LASTEXITCODE"
}

# Create the root-enumerated device node if it does not exist yet.
$existing = Get-PnpDevice -FriendlyName '*InterviewCopilot Virtual*' -ErrorAction SilentlyContinue
if (-not $existing) {
  $devcon = Join-Path $PSScriptRoot 'devcon.exe'
  if (Test-Path $devcon) {
    & $devcon install $InfPath 'ROOT\InterviewCopilotAudio' | Out-Null
  }
}

Write-Host 'Done. If the device is not listed yet, reboot once.'
