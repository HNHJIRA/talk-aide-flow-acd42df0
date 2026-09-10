//! macOS capture backend — real ScreenCaptureKit system/application audio.
//!
//! Pipeline:
//!   SCShareableContent -> pick the requested meeting application (Zoom
//!   `us.zoom.*`, Microsoft Teams `com.microsoft.teams*`)
//!   -> SCContentFilter (display + including-applications) -> SCStream with
//!   `capturesAudio = true`, `excludesCurrentProcessAudio = true` -> audio
//!   CMSampleBuffer -> AudioBufferList -> f32 mono @ native rate -> bounded
//!   crossbeam channel -> the shared worker in `audio::` (resample to 16 kHz,
//!   packetize, bridge).
//!
//! Notes:
//! * SCK always hands us deinterleaved 32-bit float PCM (48 kHz). Both the
//!   planar (one AudioBuffer per channel) and interleaved (single buffer,
//!   `number_channels > 1`) layouts are handled; we mix to mono in the callback
//!   so the worker only ever sees one channel.
//! * The `SCStream` is created, started and stopped on one owner thread. It is
//!   kept alive there for the whole capture and stopped deterministically when
//!   the shared `stop` flag flips, so the ObjC object never outlives us.
//! * Requires the Screen & System Audio Recording permission plus
//!   `NSScreenCaptureUsageDescription` in the bundle Info.plist.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use crossbeam_channel::{bounded, Sender};
use screencapturekit::prelude::*;
use screencapturekit::stream::output_type::SCStreamOutputType;

use super::{AudioCaptureBackend, SourceInfo, StartedCapture};
use crate::state::{CaptureTarget, SourceDetection};

/// Zoom Desktop bundle identifiers across channels/versions.
const ZOOM_BUNDLE_IDS: &[&str] = &["us.zoom.xos", "us.zoom.ZoomClips", "us.zoom.ZoomPresence"];

/// ScreenCaptureKit's audio output format.
const SCK_SAMPLE_RATE: u32 = 48_000;
const SCK_CHANNELS: u32 = 2;

/// ~4 s of 48 kHz mono blocks; the callback never blocks on a full channel.
const FRAME_CHANNEL_CAPACITY: usize = 256;

#[derive(Default)]
pub struct ScreenCaptureKitBackend;

/// Microsoft Teams desktop bundle identifiers (new Teams, classic, and the
/// Electron/webview helpers that actually render meeting audio).
const TEAMS_BUNDLE_IDS: &[&str] = &[
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.microsoft.teams.classic",
    "com.microsoft.teams.helper",
];

#[derive(Debug, Clone)]
struct MeetingApp {
    name: String,
    bundle_id: String,
}

fn is_zoom(bundle_id: &str, name: &str) -> bool {
    ZOOM_BUNDLE_IDS.iter().any(|id| id.eq_ignore_ascii_case(bundle_id))
        || bundle_id.to_ascii_lowercase().starts_with("us.zoom.")
        || name.to_ascii_lowercase().starts_with("zoom")
}

fn is_teams(bundle_id: &str, name: &str) -> bool {
    let bundle = bundle_id.to_ascii_lowercase();
    let app = name.to_ascii_lowercase();
    TEAMS_BUNDLE_IDS.iter().any(|id| id.eq_ignore_ascii_case(bundle_id))
        || bundle.starts_with("com.microsoft.teams")
        || app == "microsoft teams"
        || app.starts_with("microsoft teams")
}

/// Chrome-family browsers that render Google Meet audio. Meet is a web app, so
/// the "application" we capture natively is the browser process itself — the
/// Meet tab is never asked to share itself with the InterviewCopilot web app.
const CHROME_BUNDLE_IDS: &[&str] = &[
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "company.thebrowser.Browser",
];

fn is_chrome(bundle_id: &str, name: &str) -> bool {
    let bundle = bundle_id.to_ascii_lowercase();
    let app = name.to_ascii_lowercase();
    CHROME_BUNDLE_IDS.iter().any(|id| id.eq_ignore_ascii_case(bundle_id))
        || bundle.starts_with("com.google.chrome")
        || app == "google chrome"
        || app.starts_with("google chrome")
        || app.starts_with("chromium")
}

/// Does this running application belong to the requested capture target?
fn matches_target(target: CaptureTarget, bundle_id: &str, name: &str) -> bool {
    match target {
        CaptureTarget::Zoom => is_zoom(bundle_id, name),
        CaptureTarget::Teams => is_teams(bundle_id, name),
        CaptureTarget::Meet => is_chrome(bundle_id, name),
        CaptureTarget::System => false,
    }
}


/// Friendly permission-aware wording for any SCShareableContent failure.
fn shareable_error(err: &SCError) -> String {
    format!(
        "macOS did not return shareable content ({err}). Open System Settings > Privacy & \
         Security > Screen & System Audio Recording and allow InterviewCopilot Companion, \
         then quit and reopen the app."
    )
}

fn find_app(content: &SCShareableContent, target: CaptureTarget) -> Option<MeetingApp> {
    content.applications().into_iter().find_map(|app| {
        let bundle_id = app.bundle_identifier();
        let name = app.application_name();
        if matches_target(target, &bundle_id, &name) {
            Some(MeetingApp { name, bundle_id })
        } else {
            None
        }
    })
}

impl AudioCaptureBackend for ScreenCaptureKitBackend {
    fn backend_name(&self) -> &'static str {
        "screencapturekit"
    }

    fn enumerate_sources(&self) -> Vec<SourceInfo> {
        match SCShareableContent::get() {
            Ok(content) => {
                let zoom = find_app(&content, CaptureTarget::Zoom);
                let teams = find_app(&content, CaptureTarget::Teams);
                let chrome = find_app(&content, CaptureTarget::Meet);
                vec![
                    SourceInfo {
                        id: "meet".into(),
                        label: chrome
                            .as_ref()
                            .map(|c| format!("Google Meet ({})", c.name))
                            .unwrap_or_else(|| "Google Meet (Chrome not running)".into()),
                        kind: "application".into(),
                        available: chrome.is_some(),
                    },
                    SourceInfo {
                        id: "zoom".into(),
                        label: zoom
                            .as_ref()
                            .map(|z| format!("Zoom Desktop ({})", z.name))
                            .unwrap_or_else(|| "Zoom Desktop (not running)".into()),
                        kind: "application".into(),
                        available: zoom.is_some(),
                    },
                    SourceInfo {
                        id: "teams".into(),
                        label: teams
                            .as_ref()
                            .map(|t| format!("Microsoft Teams Desktop ({})", t.name))
                            .unwrap_or_else(|| "Microsoft Teams Desktop (not running)".into()),
                        kind: "application".into(),
                        available: teams.is_some(),
                    },
                    SourceInfo {
                        id: "system".into(),
                        label: "System output (all apps except this one)".into(),
                        kind: "system_audio".into(),
                        available: !content.displays().is_empty(),
                    },
                ]
            }
            Err(_) => vec![
                SourceInfo {
                    id: "meet".into(),
                    label: "Google Meet (screen & system audio permission needed)".into(),
                    kind: "application".into(),
                    available: false,
                },
                SourceInfo {
                    id: "zoom".into(),
                    label: "Zoom Desktop (screen & system audio permission needed)".into(),
                    kind: "application".into(),
                    available: false,
                },
                SourceInfo {
                    id: "teams".into(),
                    label: "Microsoft Teams Desktop (screen & system audio permission needed)".into(),
                    kind: "application".into(),
                    available: false,
                },
                SourceInfo {
                    id: "system".into(),
                    label: "System output (screen & system audio permission needed)".into(),
                    kind: "system_audio".into(),
                    available: false,
                },
            ],

        }
    }

    fn start(&self, target: CaptureTarget) -> Result<StartedCapture> {
        start_screencapturekit(target)
    }
}

/// Audio handler: mixes SCK's float PCM to mono and hands it to the worker.
struct AudioTap {
    tx: Sender<Vec<f32>>,
    dropped: Arc<std::sync::atomic::AtomicU64>,
}

impl SCStreamOutputTrait for AudioTap {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }
        let Some(list) = sample.audio_buffer_list() else {
            return;
        };
        let buffers = list.num_buffers();
        if buffers == 0 {
            return;
        }

        // Planar: N buffers x 1 channel. Interleaved: 1 buffer x N channels.
        let first = match list.get(0) {
            Some(b) => b,
            None => return,
        };
        let mut mono: Vec<f32>;

        if buffers > 1 {
            let frames = first.data_byte_size() / 4;
            if frames == 0 {
                return;
            }
            mono = vec![0.0; frames];
            let mut mixed = 0usize;
            for index in 0..buffers {
                let Some(buffer) = list.get(index) else { continue };
                let samples = as_f32(buffer.data());
                if samples.len() < frames {
                    continue;
                }
                for (out, sample) in mono.iter_mut().zip(samples.iter()) {
                    *out += *sample;
                }
                mixed += 1;
            }
            if mixed > 1 {
                let scale = 1.0 / mixed as f32;
                for out in &mut mono {
                    *out *= scale;
                }
            }
        } else {
            let channels = first.number_channels.max(1) as usize;
            let samples = as_f32(first.data());
            if samples.is_empty() {
                return;
            }
            if channels == 1 {
                mono = samples.to_vec();
            } else {
                mono = Vec::with_capacity(samples.len() / channels);
                for frame in samples.chunks_exact(channels) {
                    mono.push(frame.iter().sum::<f32>() / channels as f32);
                }
            }
        }

        if mono.is_empty() {
            return;
        }
        // Never block the CoreMedia callback thread.
        if self.tx.try_send(mono).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Reinterpret CoreMedia's little-endian float PCM bytes as `f32` samples.
fn as_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn start_screencapturekit(target: CaptureTarget) -> Result<StartedCapture> {
    let stop = Arc::new(AtomicBool::new(false));
    let (frames_tx, frames_rx) = bounded::<Vec<f32>>(FRAME_CHANNEL_CAPACITY);
    let dropped = Arc::new(std::sync::atomic::AtomicU64::new(0));

    // The SCStream is created, started, and stopped on this single owner thread.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<AppProbe, String>>();
    let thread_stop = stop.clone();
    let thread_dropped = dropped.clone();

    std::thread::Builder::new()
        .name("ic-sck-capture".into())
        .spawn(move || {
            match build_stream(target, frames_tx, thread_dropped) {
                Ok((stream, probe)) => {
                    if let Err(err) = stream.start_capture() {
                        let _ = ready_tx.send(Err(format!(
                            "macOS refused to start system audio capture ({err}). Grant \
                             Screen & System Audio Recording to InterviewCopilot Companion in \
                             System Settings > Privacy & Security, then reopen the app."
                        )));
                        return;
                    }
                    tracing::info!(
                        capture_target = %probe.capture_target,
                        "ScreenCaptureKit audio capture started"
                    );
                    let _ = ready_tx.send(Ok(probe));

                    // Own the stream until the shared stop flag flips.
                    while !thread_stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    if let Err(err) = stream.stop_capture() {
                        tracing::warn!(error = %err, "SCStream stop_capture reported an error");
                    }
                    tracing::info!("ScreenCaptureKit audio capture stopped");
                    drop(stream);
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                }
            }
        })
        .map_err(|e| anyhow!("Could not start the macOS capture thread: {e}"))?;

    // Surface permission / "Zoom not running" failures synchronously.
    let probe = match ready_rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(probe)) => probe,
        Ok(Err(message)) => {
            stop.store(true, Ordering::Relaxed);
            bail!(message);
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            bail!(
                "macOS did not respond to the screen & system audio capture request. Check \
                 System Settings > Privacy & Security > Screen & System Audio Recording."
            );
        }
    };

    Ok(StartedCapture {
        frames: frames_rx,
        stop,
        native_sample_rate: SCK_SAMPLE_RATE,
        // We mix to mono inside the CoreMedia callback.
        native_channels: 1,
        native_format: format!("f32 {SCK_CHANNELS}ch mixed to mono"),
        capture_method: "SCREENCAPTUREKIT AUDIO".into(),
        capture_target: probe.capture_target,
        source_process: probe.source_process,
        device_name: probe.device_name,
        source_detected: probe.source_detected,
        source_detection: probe.source_detection,
    })
}

#[derive(Debug, Clone)]
struct AppProbe {
    capture_target: String,
    source_process: Option<String>,
    device_name: Option<String>,
    source_detected: bool,
    source_detection: SourceDetection,
}

fn build_stream(
    target: CaptureTarget,
    frames_tx: Sender<Vec<f32>>,
    dropped: Arc<std::sync::atomic::AtomicU64>,
) -> Result<(SCStream, AppProbe)> {
    let content = SCShareableContent::get().map_err(|err| anyhow!(shareable_error(&err)))?;

    let displays = content.displays();
    let display = displays
        .first()
        .ok_or_else(|| anyhow!("macOS reported no capturable display, so system audio is unavailable."))?;

    let app_target = find_app(&content, target);

    let (filter, probe) = match (target, &app_target) {
        (CaptureTarget::Zoom | CaptureTarget::Teams | CaptureTarget::Meet, Some(app)) => {
            let apps = content
                .applications()
                .into_iter()
                .filter(|a| matches_target(target, &a.bundle_identifier(), &a.application_name()))
                .collect::<Vec<_>>();
            let refs: Vec<&SCRunningApplication> = apps.iter().collect();
            let filter = SCContentFilter::create()
                .with_display(display)
                .with_including_applications(&refs, &[])
                .build();
            (
                filter,
                AppProbe {
                    capture_target: match target {
                        CaptureTarget::Teams => "teams_application_audio".into(),
                        CaptureTarget::Meet => "meet_chrome_application_audio".into(),
                        _ => "zoom_application_audio".into(),
                    },
                    source_process: Some(format!("{} ({})", app.name, app.bundle_id)),
                    device_name: None,
                    source_detected: true,
                    source_detection: match target {
                        CaptureTarget::Teams => SourceDetection::TeamsDetected,
                        CaptureTarget::Meet => SourceDetection::MeetDetected,
                        _ => SourceDetection::ZoomDetected,
                    },
                },
            )
        }
        (CaptureTarget::Zoom | CaptureTarget::Teams | CaptureTarget::Meet, None) => {
            // Honest fallback: whole-display audio, clearly labelled as such.
            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_windows(&[])
                .build();
            (
                filter,
                AppProbe {
                    capture_target: "system_audio_fallback".into(),
                    source_process: None,
                    device_name: None,
                    source_detected: false,
                    source_detection: match target {
                        CaptureTarget::Teams => SourceDetection::TeamsNotDetected,
                        CaptureTarget::Meet => SourceDetection::MeetNotDetected,
                        _ => SourceDetection::ZoomNotDetected,
                    },
                },
            )
        }

        (CaptureTarget::System, _) => {
            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_windows(&[])
                .build();
            (
                filter,
                AppProbe {
                    capture_target: "system".into(),
                    source_process: app_target.as_ref().map(|a| a.name.clone()),
                    device_name: None,
                    source_detected: false,
                    source_detection: SourceDetection::SystemFallback,
                },
            )
        }
    };

    let config = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(SCK_SAMPLE_RATE as i32)
        .with_channel_count(SCK_CHANNELS as i32)
        // Audio-only: keep the mandatory video plane as small and slow as possible.
        .with_width(2)
        .with_height(2)
        .with_fps(1)
        .with_queue_depth(6);

    let mut stream = SCStream::new(&filter, &config);
    let handler = stream.add_output_handler(
        AudioTap { tx: frames_tx, dropped },
        SCStreamOutputType::Audio,
    );
    if handler.is_none() {
        bail!("macOS rejected the ScreenCaptureKit audio output handler.");
    }

    Ok((stream, probe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_zoom_bundle_ids() {
        assert!(is_zoom("us.zoom.xos", "zoom.us"));
        assert!(is_zoom("us.zoom.Something", "Whatever"));
        assert!(is_zoom("com.example.other", "Zoom Workplace"));
        assert!(!is_zoom("com.apple.Safari", "Safari"));
    }

    #[test]
    fn recognises_teams_bundle_ids() {
        assert!(is_teams("com.microsoft.teams2", "Microsoft Teams"));
        assert!(is_teams("com.microsoft.teams.classic", "Microsoft Teams classic"));
        assert!(is_teams("com.example.other", "Microsoft Teams (work)"));
        assert!(!is_teams("us.zoom.xos", "zoom.us"));
        assert!(!is_teams("com.apple.Safari", "Safari"));
    }

    #[test]
    fn mixes_interleaved_bytes_to_f32() {
        let bytes: Vec<u8> = [0.25f32, -0.5f32]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(as_f32(&bytes), vec![0.25, -0.5]);
    }
}
