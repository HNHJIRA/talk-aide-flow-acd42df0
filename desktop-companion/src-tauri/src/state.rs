//! Authoritative shared state for the companion.
//!
//! One state machine, no contradictory booleans.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

pub const COMPANION_APP_ID: &str = "interviewcopilot-companion";
pub const COMPANION_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Bridge protocol version understood by this build. The web app's bridge
/// client speaks `1`; bump only alongside a web-side change.
pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Idle,
    WaitingForPair,
    Paired,
    RequestingPermission,
    Starting,
    Capturing,
    Silent,
    Paused,
    Reconnecting,
    Error,
    Stopping,
}

impl CaptureState {
    /// The subset of names the browser bridge client understands.
    pub fn as_bridge_state(self) -> &'static str {
        match self {
            CaptureState::Idle | CaptureState::Stopping => "stopped",
            CaptureState::WaitingForPair => "pairing",
            CaptureState::Paired | CaptureState::Paused => "connected",
            CaptureState::RequestingPermission => "requesting_permission",
            CaptureState::Starting => "ready",
            CaptureState::Capturing => "capturing",
            CaptureState::Silent => "silent",
            CaptureState::Reconnecting => "reconnecting",
            CaptureState::Error => "error",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CaptureState::Idle => "idle",
            CaptureState::WaitingForPair => "waiting_for_pair",
            CaptureState::Paired => "paired",
            CaptureState::RequestingPermission => "requesting_permission",
            CaptureState::Starting => "starting",
            CaptureState::Capturing => "capturing",
            CaptureState::Silent => "silent",
            CaptureState::Paused => "paused",
            CaptureState::Reconnecting => "reconnecting",
            CaptureState::Error => "error",
            CaptureState::Stopping => "stopping",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTarget {
    /// Prefer per-application capture of the Zoom Desktop client.
    Zoom,
    /// Prefer per-application capture of the Microsoft Teams desktop client.
    Teams,
    /// Capture the current system output device (loopback).
    System,
}

impl CaptureTarget {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "zoom" | "zoom_desktop" => CaptureTarget::Zoom,
            "teams" | "teams_desktop" | "microsoft_teams" => CaptureTarget::Teams,
            _ => CaptureTarget::System,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureTarget::Zoom => "zoom",
            CaptureTarget::Teams => "teams",
            CaptureTarget::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceDetection {
    ZoomDetected,
    ZoomNotDetected,
    ZoomRunningNoAudio,
    TeamsDetected,
    TeamsNotDetected,
    SystemFallback,
}

impl SourceDetection {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceDetection::ZoomDetected => "zoom_detected",
            SourceDetection::ZoomNotDetected => "zoom_not_detected",
            SourceDetection::ZoomRunningNoAudio => "zoom_running_no_audio",
            SourceDetection::TeamsDetected => "teams_detected",
            SourceDetection::TeamsNotDetected => "teams_not_detected",
            SourceDetection::SystemFallback => "system_fallback",
        }
    }
}

/// Format actually negotiated with the OS, plus what we emit downstream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatInfo {
    pub native_sample_rate: u32,
    pub native_channels: u16,
    pub native_format: String,
    pub processed_sample_rate: u32,
    pub processed_channels: u16,
    pub capture_method: String,
    pub capture_target: String,
    pub source_process: Option<String>,
    pub device_name: Option<String>,
    pub source_detected: bool,
}

impl Default for FormatInfo {
    fn default() -> Self {
        Self {
            native_sample_rate: 0,
            native_channels: 0,
            native_format: "unknown".into(),
            processed_sample_rate: TARGET_SAMPLE_RATE,
            processed_channels: 1,
            capture_method: "none".into(),
            capture_target: "none".into(),
            source_process: None,
            device_name: None,
            source_detected: false,
        }
    }
}

#[derive(Default)]
pub struct Counters {
    pub packets_sent: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub buffer_drops: AtomicU64,
    pub frames_captured: AtomicU64,
}

impl Counters {
    pub fn reset(&self) {
        self.packets_sent.store(0, Ordering::Relaxed);
        self.bytes_sent.store(0, Ordering::Relaxed);
        self.buffer_drops.store(0, Ordering::Relaxed);
        self.frames_captured.store(0, Ordering::Relaxed);
    }
}

/// Messages fanned out to the authenticated browser socket.
#[derive(Debug, Clone)]
pub enum OutMsg {
    Text(String),
    Pcm(Vec<u8>),
}

/// Pairing material handed to us by the user (never a platform master secret).
#[derive(Debug, Clone)]
pub struct Pairing {
    pub bridge_token: String,
    pub session_id: String,
    pub session_title: String,
    pub expires_at: String,
    pub paired_at: Instant,
}

pub struct Inner {
    pub state: CaptureState,
    pub detail: Option<String>,
    pub pairing: Option<Pairing>,
    pub format: FormatInfo,
    pub level: f32,
    pub last_audible: Option<Instant>,
    pub last_error: Option<String>,
    pub source_detection: SourceDetection,
    pub preferred_target: CaptureTarget,
    pub bridge_connected: bool,
    pub last_browser_seen: Option<Instant>,
    pub local_test_mode: bool,
    pub port: u16,
    pub transitions: Vec<String>,
}

pub struct AppState {
    inner: RwLock<Inner>,
    pub counters: Counters,
    pub tx: broadcast::Sender<OutMsg>,
    /// Overlay control/update frames received from the authenticated browser,
    /// forwarded to the native overlay window by the main thread.
    pub overlay_tx: broadcast::Sender<serde_json::Value>,
    /// Set by whichever component owns the running capture thread.
    pub capture_stop: RwLock<Option<Arc<std::sync::atomic::AtomicBool>>>,
    pub capture_paused: Arc<std::sync::atomic::AtomicBool>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(port: u16) -> Shared {
        let (tx, _rx) = broadcast::channel(256);
        let (overlay_tx, _orx) = broadcast::channel(128);
        Arc::new(AppState {
            inner: RwLock::new(Inner {
                state: CaptureState::Idle,
                detail: None,
                pairing: None,
                format: FormatInfo::default(),
                level: 0.0,
                last_audible: None,
                last_error: None,
                source_detection: SourceDetection::ZoomNotDetected,
                preferred_target: CaptureTarget::Zoom,
                bridge_connected: false,
                last_browser_seen: None,
                local_test_mode: false,
                port,
                transitions: Vec::new(),
            }),
            counters: Counters::default(),
            tx,
            overlay_tx,
            capture_stop: RwLock::new(None),
            capture_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Send an arbitrary JSON frame to the authenticated browser socket.
    pub fn send_to_browser(&self, value: serde_json::Value) {
        let _ = self.tx.send(OutMsg::Text(value.to_string()));
    }


    pub fn read(&self) -> parking_lot::RwLockReadGuard<'_, Inner> {
        self.inner.read()
    }

    pub fn write(&self) -> parking_lot::RwLockWriteGuard<'_, Inner> {
        self.inner.write()
    }

    pub fn set_state(&self, state: CaptureState, detail: Option<String>) {
        {
            let mut inner = self.inner.write();
            if inner.state == state && inner.detail == detail {
                return;
            }
            inner.state = state;
            inner.detail = detail.clone();
            if state == CaptureState::Error {
                inner.last_error = detail.clone();
            }
            let stamp = format!("{} -> {}", chrono_like_now(), state.as_str());
            inner.transitions.push(stamp);
            if inner.transitions.len() > 200 {
                inner.transitions.remove(0);
            }
        }
        tracing::info!(state = state.as_str(), detail = ?detail, "state transition");
        self.broadcast_state();
    }

    pub fn broadcast_state(&self) {
        let (state, detail) = {
            let inner = self.inner.read();
            (inner.state, inner.detail.clone())
        };
        let mut payload = serde_json::json!({
            "type": "state",
            "state": state.as_bridge_state(),
            "companionState": state.as_str(),
        });
        if let Some(d) = detail {
            payload["detail"] = serde_json::Value::String(d);
        }
        let _ = self.tx.send(OutMsg::Text(payload.to_string()));
    }

    pub fn broadcast_format(&self) {
        let f = self.inner.read().format.clone();
        let payload = serde_json::json!({
            "type": "format",
            "sampleRate": f.processed_sample_rate,
            "channels": f.processed_channels,
            "captureMethod": f.capture_method,
            "captureTarget": f.capture_target,
            "sourceDetected": f.source_detected,
            "nativeSampleRate": f.native_sample_rate,
            "nativeChannels": f.native_channels,
            "sourceProcess": f.source_process,
            "device": f.device_name,
        });
        let _ = self.tx.send(OutMsg::Text(payload.to_string()));
    }

    pub fn broadcast_error(&self, message: &str) {
        let _ = self.tx.send(OutMsg::Text(
            serde_json::json!({ "type": "error", "message": message }).to_string(),
        ));
    }

    pub fn note_level(&self, level: f32) {
        let mut inner = self.inner.write();
        inner.level = level;
        if level > 0.02 {
            inner.last_audible = Some(Instant::now());
        }
    }

    /// Capturing but quiet for a long time => `silent`, never a disconnect.
    pub fn evaluate_silence(&self) {
        let (state, quiet_for) = {
            let inner = self.inner.read();
            let quiet = inner
                .last_audible
                .map(|t| t.elapsed())
                .unwrap_or(Duration::from_secs(3600));
            (inner.state, quiet)
        };
        match state {
            CaptureState::Capturing if quiet_for > Duration::from_secs(15) => {
                self.set_state(
                    CaptureState::Silent,
                    Some("No audio detected from the selected source.".into()),
                );
            }
            CaptureState::Silent if quiet_for < Duration::from_secs(2) => {
                self.set_state(CaptureState::Capturing, None);
            }
            _ => {}
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.inner.read();
        serde_json::json!({
            "app": COMPANION_APP_ID,
            "productName": "InterviewCopilot Companion",
            "version": COMPANION_VERSION,
            "protocolVersion": BRIDGE_PROTOCOL_VERSION,
            "os": crate::platform::os_key(),
            "osVersion": os_info::get().to_string(),
            "captureBackend": crate::platform::backend_name(),
            "captureState": inner.state.as_str(),
            "bridgeState": inner.state.as_bridge_state(),
            "detail": inner.detail,
            "port": inner.port,
            "paired": inner.pairing.is_some(),
            "sessionTitle": inner.pairing.as_ref().map(|p| p.session_title.clone()),
            "bridgeConnected": inner.bridge_connected,
            "localTestMode": inner.local_test_mode,
            "preferredTarget": inner.preferred_target.as_str(),
            "sourceDetection": inner.source_detection.as_str(),
            "level": inner.level,
            "format": inner.format,
            "counters": {
                "packetsSent": self.counters.packets_sent.load(Ordering::Relaxed),
                "bytesSent": self.counters.bytes_sent.load(Ordering::Relaxed),
                "audioBufferDrops": self.counters.buffer_drops.load(Ordering::Relaxed),
                "framesCaptured": self.counters.frames_captured.load(Ordering::Relaxed),
            },
            "lastError": inner.last_error,
        })
    }

    /// Safe, shareable diagnostics: no tokens, no audio, no transcripts.
    pub fn diagnostics(&self) -> serde_json::Value {
        let mut snap = self.snapshot();
        let inner = self.inner.read();
        snap["stateTransitions"] = serde_json::json!(inner.transitions);
        snap["generatedAt"] = serde_json::json!(chrono_like_now());
        snap
    }
}

/// Minimal monotonic-ish timestamp without pulling in a date crate.
pub fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{secs}")
}
