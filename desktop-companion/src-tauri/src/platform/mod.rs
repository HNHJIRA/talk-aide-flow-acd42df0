//! Platform capture backends behind one interface.
//!
//! `cfg(target_os)` lives here and nowhere else.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use anyhow::Result;
use crossbeam_channel::Receiver;
use serde::Serialize;

use crate::state::{CaptureTarget, SourceDetection};

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

/// A live native capture: interleaved f32 frames on a bounded channel.
pub struct StartedCapture {
    pub frames: Receiver<Vec<f32>>,
    pub stop: Arc<AtomicBool>,
    pub native_sample_rate: u32,
    pub native_channels: u16,
    pub native_format: String,
    pub capture_method: String,
    pub capture_target: String,
    pub source_process: Option<String>,
    pub device_name: Option<String>,
    pub source_detected: bool,
    pub source_detection: SourceDetection,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub available: bool,
}

/// `AudioCaptureBackend` in trait form; each platform module implements it.
pub trait AudioCaptureBackend: Send + Sync {
    fn backend_name(&self) -> &'static str;
    fn enumerate_sources(&self) -> Vec<SourceInfo>;
    fn start(&self, target: CaptureTarget) -> Result<StartedCapture>;
}

pub fn os_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "unsupported"
    }
}

pub fn backend() -> Box<dyn AudioCaptureBackend> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WasapiBackend::default())
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::ScreenCaptureKitBackend::default())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Box::new(Unsupported)
    }
}

pub fn backend_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "wasapi"
    }
    #[cfg(target_os = "macos")]
    {
        "screencapturekit"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "unsupported"
    }
}

pub fn enumerate_sources() -> Vec<SourceInfo> {
    backend().enumerate_sources()
}

pub fn start_capture(target: CaptureTarget) -> Result<StartedCapture> {
    backend().start(target)
}

/// Compile-time proof that a real native backend was selected.
///
/// CI builds with `--features require-native-backend`; if the target ever
/// resolves to the `Unsupported` stub (or the Windows module is not compiled in
/// on a Windows target), the build fails here instead of shipping a companion
/// that cannot capture anything.
#[cfg(feature = "require-native-backend")]
const _: () = {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    compile_error!(
        "require-native-backend: this target resolves to the Unsupported capture backend. \
         A real WASAPI (Windows) or ScreenCaptureKit (macOS) backend is mandatory for release builds."
    );
};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct Unsupported;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl AudioCaptureBackend for Unsupported {
    fn backend_name(&self) -> &'static str {
        "unsupported"
    }
    fn enumerate_sources(&self) -> Vec<SourceInfo> {
        Vec::new()
    }
    fn start(&self, _target: CaptureTarget) -> Result<StartedCapture> {
        anyhow::bail!("Native audio capture is only supported on Windows and macOS.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No audio is opened here: this only asserts which backend the compiler
    /// selected. Real capture is validated manually on a Windows machine.
    #[test]
    fn selected_backend_is_native_on_supported_targets() {
        let name = backend().backend_name();
        assert_eq!(name, backend_name(), "backend()/backend_name() disagree");

        #[cfg(target_os = "windows")]
        assert_eq!(
            name, "wasapi",
            "Windows build resolved to `{name}` instead of the real WASAPI backend"
        );

        #[cfg(target_os = "macos")]
        assert_eq!(name, "screencapturekit");

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        assert_eq!(name, "unsupported");
    }

    #[test]
    fn os_key_matches_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(os_key(), "windows");
        #[cfg(target_os = "macos")]
        assert_eq!(os_key(), "macos");
    }

    /// Enumeration must not silently return an empty list on Windows: the
    /// WASAPI backend always advertises the zoom + system sources.
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_backend_advertises_sources() {
        let sources = enumerate_sources();
        assert!(
            sources.iter().any(|s| s.id == "system"),
            "WASAPI backend did not advertise a system-output source"
        );
    }
}

