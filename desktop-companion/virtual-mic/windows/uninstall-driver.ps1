# Removes the InterviewCopilot Virtual Microphone driver (elevated).
#Requires -RunAsAdministrator
$ErrorActionPreference = 'SilentlyContinue'

$published = (& pnputil.exe /enum-drivers) -split "`r?`n"
$current = $null
foreach ($line in $published) {
  if ($line -match 'Published Name\s*:\s*(oem\d+\.inf)') { $current = $Matches[1] }
  if ($line -match 'InterviewCopilot' -and $current) {
    Write-Host "Removing $current"
    & pnputil.exe /delete-driver $current /uninstall /force | Out-Null
    $current = $null
  }
}
Write-Host 'InterviewCopilot Virtual Microphone removed.'
