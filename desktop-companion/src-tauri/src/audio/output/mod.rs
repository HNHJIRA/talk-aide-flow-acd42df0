//! Audio OUTPUT routing (Voice Interpreter Mode).
//!
//! Strictly separate from capture: nothing in this module touches WASAPI
//! loopback or ScreenCaptureKit. Capture stays exactly as it was.
//!
//! Architecture mirrors the capture side:
//!   * one trait (`AudioOutputRouter`) with per-platform implementations,
//!   * all platform/COM objects live on a single dedicated worker thread and
//!     are never sent across threads (no `unsafe impl Send/Sync` anywhere),
//!   * the bridge only ever pushes owned PCM buffers into a bounded channel.
//!
//! The browser produces the interpreted voice (translate -> TTS) and streams
//! 16 kHz mono little-endian PCM down the existing bridge; this module renders
//! it to the selected output device so the meeting app picks it up as a
//! microphone (a virtual audio device such as VB-CABLE / BlackHole).

use anyhow::Result;
use crossbeam_channel::{bounded, Receiver, Sender};
use serde::Serialize;

#[cfg(target_os = "windows")]
pub mod wasapi_virtual_mic;

#[cfg(target_os = "macos")]
pub mod coreaudio_virtual_mic;

/// An output device the interpreted voice can be rendered to.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OutputDevice {
    pub id: String,
    pub label: String,
    /// True when the name matches a known virtual-audio driver.
    pub virtual_device: bool,
    pub default_device: bool,
}

/// Names shipped by the common virtual audio drivers on each platform.
const VIRTUAL_HINTS: [&str; 8] = [
    "cable",
    "vb-audio",
    "voicemeeter",
    "blackhole",
    "loopback",
    "soundflower",
    "virtual",
    "interviewcopilot",
];

pub fn looks_virtual(label: &str) -> bool {
    let lower = label.to_lowercase();
    VIRTUAL_HINTS.iter().any(|hint| lower.contains(hint))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputState {
    Idle,
    Routing,
    Unavailable,
}

/// Per-platform output backend. Implementations are constructed *on* the
/// worker thread and never leave it.
pub trait AudioOutputRouter {
    fn backend_name(&self) -> &'static str;
    fn enumerate_devices(&self) -> Vec<OutputDevice>;
    /// Bind the router to a device id (empty string = system default).
    fn open(&mut self, device_id: &str, sample_rate: u32) -> Result<()>;
    /// Render one buffer of mono f32 samples at the opened sample rate.
    fn write(&mut self, samples: &[f32]) -> Result<()>;
    fn close(&mut self);
}

/// Command sent from the bridge to the output worker thread.
pub enum OutputCommand {
    Open { device_id: String, sample_rate: u32 },
    Pcm(Vec<f32>),
    Close,
    Shutdown,
}

/// Thread-confined handle. Cloneable, holds only a channel — never a device.
#[derive(Clone)]
pub struct OutputHandle {
    tx: Sender<OutputCommand>,
}

impl OutputHandle {
    pub fn open(&self, device_id: &str, sample_rate: u32) {
        let _ = self.tx.try_send(OutputCommand::Open {
            device_id: device_id.to_string(),
            sample_rate,
        });
    }

    /// Non-blocking: a full queue drops the oldest speech rather than stalling
    /// the bridge (an interpreter that lags behind is worse than one that skips).
    pub fn write(&self, samples: Vec<f32>) {
        let _ = self.tx.try_send(OutputCommand::Pcm(samples));
    }

    pub fn close(&self) {
        let _ = self.tx.try_send(OutputCommand::Close);
    }

    pub fn shutdown(&self) {
        let _ = self.tx.try_send(OutputCommand::Shutdown);
    }
}

fn make_router() -> Box<dyn AudioOutputRouter> {
    #[cfg(target_os = "windows")]
    {
        Box::new(wasapi_virtual_mic::WasapiOutputRouter::default())
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(coreaudio_virtual_mic::CoreAudioOutputRouter::default())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Box::new(UnsupportedOutputRouter)
    }
}

pub fn backend_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "wasapi-virtual-mic"
    }
    #[cfg(target_os = "macos")]
    {
        "coreaudio-virtual-mic"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "unsupported"
    }
}

/// Enumerate output devices without starting the worker (cheap, read-only).
pub fn enumerate_devices() -> Vec<OutputDevice> {
    make_router().enumerate_devices()
}

/// Spawn the output worker. The returned handle is the ONLY way in.
pub fn spawn() -> OutputHandle {
    let (tx, rx): (Sender<OutputCommand>, Receiver<OutputCommand>) = bounded(256);
    std::thread::Builder::new()
        .name("ic-audio-output".into())
        .spawn(move || {
            // Constructed here so every platform/COM object stays on this thread.
            let mut router = make_router();
            tracing::info!(backend = router.backend_name(), "output router thread started");
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    OutputCommand::Open { device_id, sample_rate } => {
                        if let Err(err) = router.open(&device_id, sample_rate) {
                            tracing::warn!(error = %err, device = %device_id, "output open failed");
                        }
                    }
                    OutputCommand::Pcm(samples) => {
                        if let Err(err) = router.write(&samples) {
                            tracing::warn!(error = %err, "output write failed");
                        }
                    }
                    OutputCommand::Close => router.close(),
                    OutputCommand::Shutdown => {
                        router.close();
                        break;
                    }
                }
            }
            tracing::info!("output router thread exiting");
        })
        .ok();
    OutputHandle { tx }
}

/// Decode 16-bit little-endian PCM (the bridge wire format) into mono f32.
pub fn linear16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub struct UnsupportedOutputRouter;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl AudioOutputRouter for UnsupportedOutputRouter {
    fn backend_name(&self) -> &'static str {
        "unsupported"
    }
    fn enumerate_devices(&self) -> Vec<OutputDevice> {
        Vec::new()
    }
    fn open(&mut self, _device_id: &str, _sample_rate: u32) -> Result<()> {
        anyhow::bail!("Audio output routing is only supported on Windows and macOS.")
    }
    fn write(&mut self, _samples: &[f32]) -> Result<()> {
        Ok(())
    }
    fn close(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_devices_are_recognised() {
        assert!(looks_virtual("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(looks_virtual("BlackHole 2ch"));
        assert!(!looks_virtual("MacBook Pro Speakers"));
        assert!(!looks_virtual("Realtek High Definition Audio"));
    }

    #[test]
    fn linear16_decodes_to_normalised_f32() {
        let bytes = [0u8, 0u8, 0x00, 0x40];
        let samples = linear16_to_f32(&bytes);
        assert_eq!(samples.len(), 2);
        assert!((samples[0]).abs() < f32::EPSILON);
        assert!((samples[1] - 0.5).abs() < 0.01);
    }

    /// The handle must be a pure channel wrapper so no device object can leak
    /// off the worker thread.
    #[test]
    fn handle_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OutputHandle>();
    }
}
