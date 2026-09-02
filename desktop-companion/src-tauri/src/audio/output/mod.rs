//! Interpreter audio OUTPUT routing (Voice Interpreter Mode).
//!
//! Strictly separate from capture: nothing in this module touches WASAPI
//! loopback or ScreenCaptureKit, and it shares no state with them.
//!
//! Architecture:
//!   * one trait (`AudioOutputRouter`) with per-platform implementations,
//!   * every platform/COM object is created inside the dedicated
//!     `ic-audio-output` worker thread and never crosses a thread boundary
//!     (no `unsafe impl Send/Sync` anywhere),
//!   * the bridge only pushes owned PCM buffers into a bounded channel,
//!   * a jitter buffer + linear resampler sit between the network cadence and
//!     the device clock, with underrun protection and drop accounting.
//!
//! The browser produces the interpreted voice (translate -> TTS), decodes it
//! to 16 kHz mono PCM16 and streams it as *binary* WebSocket frames; this
//! module renders it to the selected output device.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;
use crossbeam_channel::{bounded, Receiver, Sender};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::{json, Value};

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod render;

#[cfg(target_os = "windows")]
pub mod wasapi_virtual_mic;

#[cfg(target_os = "macos")]
pub mod coreaudio_virtual_mic;

/// Branded InterviewCopilot Virtual Microphone (detection + routing target).
pub mod virtual_mic;

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

/// Live counters for the "Interpreter Output Diagnostics" panel. Deliberately
/// separate from the meeting/capture counters — these two must never mix.
#[derive(Default)]
pub struct OutputStats {
    pub open: AtomicBool,
    pub sample_rate_in: AtomicU32,
    pub sample_rate_out: AtomicU32,
    pub buffer_frames: AtomicU32,
    pub buffered_ms: AtomicU32,
    pub frames_in: AtomicU64,
    pub frames_out: AtomicU64,
    pub dropped_frames: AtomicU64,
    pub underruns: AtomicU64,
    pub latency_ms: AtomicU32,
    pub device: RwLock<String>,
    pub last_error: RwLock<String>,
}

impl OutputStats {
    pub fn snapshot(&self) -> Value {
        json!({
            "backend": backend_name(),
            "open": self.open.load(Ordering::Relaxed),
            "device": self.device.read().clone(),
            "sampleRateIn": self.sample_rate_in.load(Ordering::Relaxed),
            "sampleRateOut": self.sample_rate_out.load(Ordering::Relaxed),
            "bufferFrames": self.buffer_frames.load(Ordering::Relaxed),
            "bufferedMs": self.buffered_ms.load(Ordering::Relaxed),
            "framesIn": self.frames_in.load(Ordering::Relaxed),
            "framesOut": self.frames_out.load(Ordering::Relaxed),
            "droppedFrames": self.dropped_frames.load(Ordering::Relaxed),
            "underruns": self.underruns.load(Ordering::Relaxed),
            "latencyMs": self.latency_ms.load(Ordering::Relaxed),
            "lastError": self.last_error.read().clone(),
        })
    }

    pub fn reset(&self) {
        self.frames_in.store(0, Ordering::Relaxed);
        self.frames_out.store(0, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.underruns.store(0, Ordering::Relaxed);
        self.buffered_ms.store(0, Ordering::Relaxed);
        *self.last_error.write() = String::new();
    }
}

pub static OUTPUT_STATS: Lazy<Arc<OutputStats>> = Lazy::new(|| Arc::new(OutputStats::default()));

pub fn stats() -> Arc<OutputStats> {
    OUTPUT_STATS.clone()
}

/// Per-platform output backend. Implementations are constructed *on* the
/// worker thread and never leave it.
pub trait AudioOutputRouter {
    fn backend_name(&self) -> &'static str;
    fn enumerate_devices(&self) -> Vec<OutputDevice>;
    /// Bind the router to a device id (empty string = system default).
    fn open(&mut self, device_id: &str, sample_rate: u32) -> Result<()>;
    /// Render one buffer of mono f32 samples at the opened input sample rate.
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

    /// Non-blocking: a full queue drops the newest speech rather than stalling
    /// the bridge (an interpreter that lags behind is worse than one that skips).
    pub fn write(&self, samples: Vec<f32>) {
        let len = samples.len() as u64;
        if self.tx.try_send(OutputCommand::Pcm(samples)).is_err() {
            OUTPUT_STATS.dropped_frames.fetch_add(len, Ordering::Relaxed);
        }
    }

    /// Binary wire format from the browser: 16-bit little-endian mono PCM.
    pub fn write_pcm16(&self, bytes: &[u8]) {
        self.write(linear16_to_f32(bytes));
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
        "wasapi-render"
    }
    #[cfg(target_os = "macos")]
    {
        "coreaudio-render"
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
    let (tx, rx): (Sender<OutputCommand>, Receiver<OutputCommand>) = bounded(512);
    std::thread::Builder::new()
        .name("ic-audio-output".into())
        .spawn(move || {
            // Constructed here so every platform/COM object stays on this thread.
            let mut router = make_router();
            tracing::info!(backend = router.backend_name(), "interpreter output thread started");
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    OutputCommand::Open { device_id, sample_rate } => {
                        OUTPUT_STATS.reset();
                        OUTPUT_STATS.sample_rate_in.store(sample_rate, Ordering::Relaxed);
                        let resolved = virtual_mic::resolve_device_id(&device_id);
                        match router.open(&resolved, sample_rate) {
                            Ok(()) => {
                                OUTPUT_STATS.open.store(true, Ordering::Relaxed);
                            }
                            Err(err) => {
                                OUTPUT_STATS.open.store(false, Ordering::Relaxed);
                                *OUTPUT_STATS.last_error.write() = err.to_string();
                                tracing::warn!(error = %err, device = %device_id, "interpreter output open failed");
                            }
                        }
                    }
                    OutputCommand::Pcm(samples) => {
                        OUTPUT_STATS
                            .frames_in
                            .fetch_add(samples.len() as u64, Ordering::Relaxed);
                        virtual_mic::note_level(&samples);
                        if let Err(err) = router.write(&samples) {
                            *OUTPUT_STATS.last_error.write() = err.to_string();
                            tracing::warn!(error = %err, "interpreter output write failed");
                        }
                    }
                    OutputCommand::Close => {
                        router.close();
                        OUTPUT_STATS.open.store(false, Ordering::Relaxed);
                    }
                    OutputCommand::Shutdown => {
                        router.close();
                        OUTPUT_STATS.open.store(false, Ordering::Relaxed);
                        break;
                    }
                }
            }
            tracing::info!("interpreter output thread exiting");
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

/// Linear resampler used by the render path. Cheap and allocation-light; the
/// interpreter voice is speech, so linear interpolation is inaudible here.
pub fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() || from == 0 || to == 0 {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = *input.get(idx).unwrap_or(&0.0);
        let b = *input.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
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
        anyhow::bail!("Interpreter audio output is only supported on Windows and macOS.")
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

    #[test]
    fn resampling_scales_length() {
        let input = vec![0.0f32; 160];
        let out = resample_linear(&input, 16_000, 48_000);
        assert_eq!(out.len(), 480);
        assert_eq!(resample_linear(&input, 16_000, 16_000).len(), 160);
    }

    /// The handle must be a pure channel wrapper so no device object can leak
    /// off the worker thread.
    #[test]
    fn handle_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OutputHandle>();
    }
}
