//! macOS capture backend (ScreenCaptureKit) — milestone 4.
//!
//! Deliberately NOT implemented with a browser/fake capture stand-in. Until the
//! real ScreenCaptureKit binding lands, starting capture on macOS returns an
//! explicit, honest error so the web app can fall back to browser tab audio.
//!
//! Planned implementation:
//!   SCShareableContent -> application picker (prefer the Zoom bundle id
//!   `us.zoom.xos`) -> SCStreamConfiguration { capturesAudio = true,
//!   excludesCurrentProcessAudio = true } -> SCStream audio output ->
//!   CMSampleBuffer -> f32 interleaved -> the shared pipeline in `audio::`.
//!   Requires NSScreenCaptureUsageDescription in the bundle and the
//!   Screen & System Audio Recording permission.

use anyhow::{bail, Result};

use super::{AudioCaptureBackend, SourceInfo, StartedCapture};
use crate::state::CaptureTarget;

#[derive(Default)]
pub struct ScreenCaptureKitBackend;

impl AudioCaptureBackend for ScreenCaptureKitBackend {
    fn backend_name(&self) -> &'static str {
        "screencapturekit"
    }

    fn enumerate_sources(&self) -> Vec<SourceInfo> {
        vec![SourceInfo {
            id: "zoom".into(),
            label: "Zoom Desktop (ScreenCaptureKit — not yet implemented)".into(),
            kind: "application".into(),
            available: false,
        }]
    }

    fn start(&self, _target: CaptureTarget) -> Result<StartedCapture> {
        bail!(
            "Native macOS capture (ScreenCaptureKit) is not implemented in this build. \
             Use browser tab audio in InterviewCopilot until the macOS milestone ships."
        )
    }
}
