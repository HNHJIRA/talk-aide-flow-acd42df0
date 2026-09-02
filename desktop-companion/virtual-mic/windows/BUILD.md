# Building the Windows driver (icvad)

Must run on Windows — this repo only carries the packaging/detection glue.

## Prerequisites
* Visual Studio 2022 + Spectre-mitigated libs
* Windows Driver Kit (WDK) 10.0.22621+
* EV code-signing certificate + Microsoft Hardware Dev Center account

## Steps
1. Clone `microsoft/Windows-driver-samples`, open `audio/sysvad`.
2. Trim to a single device with two endpoints (one render, one capture) and
   replace the endpoint plumbing with a lock-free ring buffer:
   render `EvtStreamWrite` pushes frames; capture `EvtStreamRead` pops them,
   filling silence on underrun and dropping the oldest frames past ~200 ms.
3. Rename the binary to `icvad.sys` and use `icvad.inf` from this folder.
4. Build `Release | x64` and `Release | ARM64`.
5. Create the catalog: `inf2cat /driver:. /os:10_x64,10_ARM64`.
6. Sign the cat with the EV certificate (`signtool sign /fd sha256 /a ...`).
7. Submit the cab to Hardware Dev Center for attestation signing; ship the
   returned signed package as the installer payload.

## Local testing without attestation
```
bcdedit /set testsigning on   :: reboot required
.\install-driver.ps1
```
Turn test signing off again when done.

## Verifying
```
Get-PnpDevice -FriendlyName '*InterviewCopilot*'
```
The Companion diagnostics must then show `Virtual Mic: installed`.
