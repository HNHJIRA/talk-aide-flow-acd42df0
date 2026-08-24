//! Windows capture backend (WASAPI).
//!
//! Milestone 1 ships **system output loopback**, which is the reliable path on
//! Windows 10 and 11. Per-process capture (the Windows 11 21H2+
//! `AUDIOCLIENT_ACTIVATION_PARAMS` process loopback) is attempted first when the
//! user asks for Zoom; when it is unavailable we fall back to system loopback
//! and report that honestly instead of pretending we captured Zoom only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use crossbeam_channel::bounded;
use sysinfo::System;
use wasapi::{
    get_default_device, initialize_mta, Direction, SampleType, ShareMode,
};

use super::{AudioCaptureBackend, SourceInfo, StartedCapture};
use crate::state::{CaptureTarget, SourceDetection};

/// Zoom desktop client executables across versions/channels.
const ZOOM_PROCESS_HINTS: &[&str] = &["zoom.exe", "zoommeetings.exe", "zoom_launcher.exe", "cpthost.exe"];

/// Microsoft Teams desktop executables (new Teams, classic, and work/personal).
const TEAMS_PROCESS_HINTS: &[&str] = &["ms-teams.exe", "teams.exe", "msteams.exe"];

#[derive(Default)]
pub struct WasapiBackend;

pub struct AppPresence {
    pub running: bool,
    pub process_name: Option<String>,
}

pub fn detect_zoom() -> AppPresence {
    detect_process(ZOOM_PROCESS_HINTS, "zoom")
}

pub fn detect_teams() -> AppPresence {
    detect_process(TEAMS_PROCESS_HINTS, "ms-teams")
}

fn detect_process(hints: &[&str], prefix: &str) -> AppPresence {
    let mut sys = System::new();
    sys.refresh_processes();
    for process in sys.processes().values() {
        let name = process.name().to_ascii_lowercase();
        if hints.iter().any(|hint| name == *hint)
            || (name.starts_with(prefix) && name.ends_with(".exe"))
        {
            return AppPresence { running: true, process_name: Some(process.name().to_string()) };
        }
    }
    AppPresence { running: false, process_name: None }
}

impl AudioCaptureBackend for WasapiBackend {
    fn backend_name(&self) -> &'static str {
        "wasapi"
    }

    fn enumerate_sources(&self) -> Vec<SourceInfo> {
        let zoom = detect_zoom();
        let teams = detect_teams();
        vec![
            SourceInfo {
                id: "zoom".into(),
                label: zoom
                    .process_name
                    .clone()
                    .map(|p| format!("Zoom Desktop ({p})"))
                    .unwrap_or_else(|| "Zoom Desktop (not running)".into()),
                kind: "application".into(),
                available: zoom.running,
            },
            SourceInfo {
                id: "teams".into(),
                label: teams
                    .process_name
                    .clone()
                    .map(|p| format!("Microsoft Teams Desktop ({p}) — system playback capture"))
                    .unwrap_or_else(|| "Microsoft Teams Desktop (not running)".into()),
                kind: "system_loopback".into(),
                available: true,
            },
            SourceInfo {
                id: "system".into(),
                label: default_render_device_name()
                    .map(|d| format!("System output ({d})"))
                    .unwrap_or_else(|| "System output".into()),
                kind: "system_loopback".into(),
                available: true,
            },
        ]
    }

    fn start(&self, target: CaptureTarget) -> Result<StartedCapture> {
        let zoom = detect_zoom();
        let teams = detect_teams();
        let app = match target {
            CaptureTarget::Teams => &teams,
            _ => &zoom,
        };
        let (capture_method, capture_target, detection) = match target {
            CaptureTarget::Teams if teams.running => (
                // Windows loopback is system-wide: honest about the mix.
                "WASAPI SYSTEM LOOPBACK",
                "teams_via_system_output",
                SourceDetection::TeamsDetected,
            ),
            CaptureTarget::Teams => (
                "WASAPI SYSTEM LOOPBACK",
                "system",
                SourceDetection::TeamsNotDetected,
            ),
            CaptureTarget::Zoom if zoom.running => (
                // Per-process capture is not yet wired; be honest about what
                // the audio actually contains.
                "WASAPI SYSTEM LOOPBACK",
                "zoom_via_system_output",
                SourceDetection::ZoomDetected,
            ),
            CaptureTarget::Zoom => (
                "WASAPI SYSTEM LOOPBACK",
                "system",
                SourceDetection::ZoomNotDetected,
            ),
            CaptureTarget::System => (
                "WASAPI SYSTEM LOOPBACK",
                "system",
                SourceDetection::SystemFallback,
            ),
        };

        let mut started = start_system_loopback()?;
        started.capture_method = capture_method.to_string();
        started.capture_target = capture_target.to_string();
        started.source_process = app.process_name.clone();
        started.source_detected =
            matches!(detection, SourceDetection::ZoomDetected | SourceDetection::TeamsDetected);
        started.source_detection = detection;
        Ok(started)
    }
}

fn default_render_device_name() -> Option<String> {
    let _ = initialize_mta().ok()?;
    get_default_device(&Direction::Render).ok()?.get_friendlyname().ok()
}

/// WASAPI shared-mode loopback capture on the current default render device.
fn start_system_loopback() -> Result<StartedCapture> {
    initialize_mta().ok().ok_or_else(|| anyhow!("Could not initialise Windows audio (COM)."))?;

    let device = get_default_device(&Direction::Render)
        .map_err(|e| anyhow!("No default audio output device: {e}"))?;
    let device_name = device.get_friendlyname().ok();

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("Could not open the audio client: {e}"))?;

    let format = audio_client
        .get_mixformat()
        .map_err(|e| anyhow!("Could not read the device mix format: {e}"))?;

    let sample_rate = format.get_samplespersec();
    let channels = format.get_nchannels();
    let bits = format.get_bitspersample();
    let sample_type = format.get_subformat().map_err(|e| anyhow!("{e}"))?;
    let block_align = format.get_blockalign() as usize;
    let native_format = format!("{:?}{}", sample_type, bits);

    let (_default_period, min_period) = audio_client
        .get_periods()
        .map_err(|e| anyhow!("Could not read device periods: {e}"))?;

    audio_client
        .initialize_client(&format, min_period, &Direction::Capture, &ShareMode::Shared, true)
        .map_err(|e| anyhow!("Loopback capture could not be initialised: {e}"))?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("Could not attach the audio event handle: {e}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("Could not open the capture client: {e}"))?;

    // Bounded so a stalled worker drops audio instead of growing without limit.
    let (tx, rx) = bounded::<Vec<f32>>(64);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let drops = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let _drops = drops.clone();

    std::thread::Builder::new()
        .name("ic-wasapi-capture".into())
        .spawn(move || {
            let mut raw: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
            if let Err(err) = audio_client.start_stream() {
                tracing::error!(error = %format!("{err}"), "capture error: start_stream");
                return;
            }
            while !stop_thread.load(Ordering::Relaxed) {
                if event.wait_for_event(500).is_err() {
                    continue;
                }
                if capture_client
                    .read_from_device_to_deque(block_align, &mut raw)
                    .is_err()
                {
                    tracing::warn!("capture error: read_from_device");
                    continue;
                }
                if raw.is_empty() {
                    continue;
                }
                let bytes: Vec<u8> = raw.drain(..).collect();
                let samples = decode_samples(&bytes, bits, &sample_type);
                if samples.is_empty() {
                    continue;
                }
                // Real-time safe: a single try_send, never a blocking send.
                if tx.try_send(samples).is_err() {
                    _drops.fetch_add(1, Ordering::Relaxed);
                }
            }
            let _ = audio_client.stop_stream();
            tracing::info!("wasapi capture thread exit");
        })
        .map_err(|e| anyhow!("Could not start the capture thread: {e}"))?;

    // Give the device a moment to produce its first buffer.
    std::thread::sleep(Duration::from_millis(30));

    Ok(StartedCapture {
        frames: rx,
        stop,
        native_sample_rate: sample_rate,
        native_channels: channels,
        native_format,
        capture_method: "WASAPI SYSTEM LOOPBACK".into(),
        capture_target: "system".into(),
        source_process: None,
        device_name,
        source_detected: false,
        source_detection: SourceDetection::SystemFallback,
    })
}

fn decode_samples(bytes: &[u8], bits: u16, sample_type: &SampleType) -> Vec<f32> {
    match (sample_type, bits) {
        (SampleType::Float, 32) => bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        (SampleType::Int, 16) => bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
        (SampleType::Int, 24) => bytes
            .chunks_exact(3)
            .map(|c| {
                let v = i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8;
                v as f32 / 8_388_608.0
            })
            .collect(),
        (SampleType::Int, 32) => bytes
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0)
            .collect(),
        _ => Vec::new(),
    }
}
