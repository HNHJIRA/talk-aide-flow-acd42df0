//! InterviewCopilot Virtual Microphone — capture-endpoint integration.
//!
//! Phase 2 of the Voice Interpreter output path. The render side (Phase 1) is
//! unchanged: TTS -> PCM -> bridge -> `ic-audio-output` worker -> render
//! device. This module only answers two questions:
//!
//!   1. is the branded virtual device present on this machine, and
//!   2. which output endpoint should the interpreter voice be rendered into
//!      so that Zoom / Teams / Google Meet can pick it up as a microphone?
//!
//! It contains NO capture code and shares no state with meeting capture
//! (WASAPI loopback / ScreenCaptureKit). If the branded device is missing we
//! degrade honestly: `installed = false`, the caller keeps rendering to the
//! chosen (or default) device and the browser fallback stays available.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::{json, Value};

/// The single user-visible name. Windows driver INF and macOS HAL plugin must
/// publish exactly this string, otherwise detection below will not match.
pub const VIRTUAL_MIC_NAME: &str = "InterviewCopilot Virtual Microphone";
/// The render-side endpoint the driver exposes (what we play into).
pub const VIRTUAL_MIC_RENDER_NAME: &str = "InterviewCopilot Virtual Audio";

/// Device-id sentinel the browser can pass to mean "use the branded device
/// if it exists, otherwise the system default".
pub const VIRTUAL_MIC_DEVICE_ID: &str = "interviewcopilot-virtual-mic";

/// macOS: where the AudioServerPlugIn bundle must live once installed.
#[cfg(target_os = "macos")]
pub const MACOS_PLUGIN_PATH: &str =
    "/Library/Audio/Plug-Ins/HAL/InterviewCopilotAudio.driver";

/// Windows: the driver's hardware id published by the INF.
#[cfg(target_os = "windows")]
pub const WINDOWS_HARDWARE_ID: &str = "ROOT\\InterviewCopilotAudio";

fn matches_branded(label: &str) -> bool {
    let lower = label.to_lowercase();
    lower.contains("interviewcopilot")
}

/// Live health of the virtual microphone, surfaced in its own diagnostics
/// block (never mixed with meeting latency counters).
#[derive(Default)]
pub struct VirtualMicStats {
    /// Peak level of the last rendered buffer, x1000.
    pub level_milli: AtomicU32,
    pub frames_rendered: AtomicU64,
    pub dropped_frames: AtomicU64,
    pub latency_ms: AtomicU32,
    /// Meeting app observed holding the endpoint, when the OS can tell us.
    pub consumer: RwLock<String>,
    pub device: RwLock<String>,
    pub note: RwLock<String>,
}

pub static VIRTUAL_MIC_STATS: Lazy<Arc<VirtualMicStats>> =
    Lazy::new(|| Arc::new(VirtualMicStats::default()));

pub fn stats() -> Arc<VirtualMicStats> {
    VIRTUAL_MIC_STATS.clone()
}

/// Record the peak level of a rendered buffer (cheap, lock-free).
pub fn note_level(samples: &[f32]) {
    let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs())).min(1.0);
    VIRTUAL_MIC_STATS
        .level_milli
        .store((peak * 1000.0) as u32, Ordering::Relaxed);
    VIRTUAL_MIC_STATS
        .frames_rendered
        .fetch_add(samples.len() as u64, Ordering::Relaxed);
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualMicStatus {
    /// Driver / HAL plugin present on this machine.
    pub installed: bool,
    /// Interpreter output currently bound to the branded endpoint.
    pub active: bool,
    pub device_name: String,
    pub render_endpoint: String,
    pub platform: &'static str,
    /// Third-party cables found, used only for the "you don't need these" hint.
    pub third_party_devices: Vec<String>,
    pub install_hint: String,
}

/// Is the branded device installed? Checked two ways: the platform install
/// marker (file/registry) and the audio-device list, so a half-installed
/// driver is reported as missing rather than silently failing at runtime.
pub fn detect() -> VirtualMicStatus {
    let devices = super::enumerate_devices();
    let branded = devices.iter().find(|d| matches_branded(&d.label));
    let third_party: Vec<String> = devices
        .iter()
        .filter(|d| d.virtual_device && !matches_branded(&d.label))
        .map(|d| d.label.clone())
        .collect();

    let marker = install_marker_present();
    let installed = marker && branded.is_some();

    let active = super::OUTPUT_STATS.open.load(Ordering::Relaxed)
        && matches_branded(&super::OUTPUT_STATS.device.read());

    VirtualMicStatus {
        installed,
        active,
        device_name: branded
            .map(|d| d.label.clone())
            .unwrap_or_else(|| VIRTUAL_MIC_NAME.to_string()),
        render_endpoint: VIRTUAL_MIC_RENDER_NAME.to_string(),
        platform: platform_name(),
        third_party_devices: third_party,
        install_hint: install_hint(marker, branded.is_some()),
    }
}

fn install_hint(marker: bool, device_visible: bool) -> String {
    match (marker, device_visible) {
        (true, true) => String::new(),
        (true, false) => {
            "Driver files are installed but the audio endpoint is not published yet. \
             Restart the machine (Windows) or run `sudo killall coreaudiod` (macOS)."
                .to_string()
        }
        (false, _) => {
            "InterviewCopilot Virtual Microphone is not installed. Install it from \
             the Companion (Settings -> Virtual Microphone) — no VB-CABLE, BlackHole \
             or Loopback is required."
                .to_string()
        }
    }
}

fn platform_name() -> &'static str {
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

/// Platform install marker: the driver payload the installer drops.
pub fn install_marker_present() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new(MACOS_PLUGIN_PATH).exists()
    }
    #[cfg(target_os = "windows")]
    {
        // The INF-installed driver co-installs its runtime marker next to the
        // system driver store copy; checking the file avoids a registry
        // dependency and works for both per-user and machine installs.
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        std::path::Path::new(&format!("{root}\\System32\\drivers\\icvad.sys")).exists()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

/// Resolve the device id the output router should open. `interviewcopilot-
/// virtual-mic` (or an empty id when the branded device exists) maps to the
/// branded render endpoint; anything else is passed through untouched so the
/// existing behaviour and the fallback path stay intact.
pub fn resolve_device_id(requested: &str) -> String {
    if requested != VIRTUAL_MIC_DEVICE_ID {
        return requested.to_string();
    }
    let devices = super::enumerate_devices();
    devices
        .iter()
        .find(|d| matches_branded(&d.label))
        .map(|d| d.id.clone())
        .unwrap_or_default() // empty => system default (honest fallback)
}

pub fn snapshot() -> Value {
    let status = detect();
    let s = &*VIRTUAL_MIC_STATS;
    json!({
        "installed": status.installed,
        "active": status.active,
        "deviceName": status.device_name,
        "renderEndpoint": status.render_endpoint,
        "platform": status.platform,
        "thirdPartyDevices": status.third_party_devices,
        "installHint": status.install_hint,
        "level": s.level_milli.load(Ordering::Relaxed) as f32 / 1000.0,
        "framesRendered": s.frames_rendered.load(Ordering::Relaxed),
        "droppedFrames": super::OUTPUT_STATS.dropped_frames.load(Ordering::Relaxed),
        "latencyMs": super::OUTPUT_STATS.latency_ms.load(Ordering::Relaxed),
        "consumer": s.consumer.read().clone(),
        "note": s.note.read().clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branded_names_match_only_our_device() {
        assert!(matches_branded("InterviewCopilot Virtual Microphone"));
        assert!(matches_branded("interviewcopilot virtual audio"));
        assert!(!matches_branded("BlackHole 2ch"));
        assert!(!matches_branded("CABLE Input (VB-Audio Virtual Cable)"));
    }

    #[test]
    fn unknown_device_ids_pass_through_untouched() {
        assert_eq!(resolve_device_id("Speakers"), "Speakers");
        assert_eq!(resolve_device_id(""), "");
    }

    #[test]
    fn level_metering_tracks_peak() {
        note_level(&[0.0, -0.5, 0.25]);
        assert_eq!(VIRTUAL_MIC_STATS.level_milli.load(Ordering::Relaxed), 500);
    }
}
