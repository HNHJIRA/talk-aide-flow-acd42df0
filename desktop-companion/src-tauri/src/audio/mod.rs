//! Audio pipeline: platform capture -> bounded channel -> worker -> bridge.
//!
//! The OS audio callback only ever pushes into a bounded channel; every
//! allocation-heavy step (downmix, resample, serialization) happens on the
//! worker thread below.

pub mod resample;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};

use crate::platform::{self, StartedCapture};
use crate::state::{CaptureState, CaptureTarget, OutMsg, Shared, TARGET_SAMPLE_RATE};

/// ~40 ms of 16 kHz mono audio per packet (640 samples / 1280 bytes).
const PACKET_SAMPLES: usize = 640;
const LEVEL_INTERVAL: Duration = Duration::from_millis(200);

pub fn start_capture(state: &Shared, target: CaptureTarget) -> Result<()> {
    stop_capture(state);

    state.set_state(CaptureState::RequestingPermission, None);
    state.counters.reset();
    state.capture_paused.store(false, Ordering::Relaxed);

    let started: StartedCapture = match platform::start_capture(target) {
        Ok(s) => s,
        Err(err) => {
            let msg = format!("{err}");
            tracing::error!(error = %msg, "capture error");
            state.set_state(CaptureState::Error, Some(msg.clone()));
            state.broadcast_error(&msg);
            return Err(anyhow!(msg));
        }
    };

    {
        let mut inner = state.write();
        inner.format.native_sample_rate = started.native_sample_rate;
        inner.format.native_channels = started.native_channels;
        inner.format.native_format = started.native_format.clone();
        inner.format.processed_sample_rate = TARGET_SAMPLE_RATE;
        inner.format.processed_channels = 1;
        inner.format.capture_method = started.capture_method.clone();
        inner.format.capture_target = started.capture_target.clone();
        inner.format.source_process = started.source_process.clone();
        inner.format.device_name = started.device_name.clone();
        inner.format.source_detected = started.source_detected;
        inner.source_detection = started.source_detection;
        inner.last_audible = None;
    }
    tracing::info!(
        method = %started.capture_method,
        native_rate = started.native_sample_rate,
        native_channels = started.native_channels,
        "capture started; format detected"
    );
    state.broadcast_format();
    state.set_state(CaptureState::Starting, None);

    *state.capture_stop.write() = Some(started.stop.clone());

    spawn_worker(state.clone(), started);
    Ok(())
}

fn spawn_worker(state: Shared, started: StartedCapture) {
    let stop = started.stop.clone();
    let paused = state.capture_paused.clone();
    let rx = started.frames;
    let channels = started.native_channels;
    let native_rate = started.native_sample_rate;

    std::thread::Builder::new()
        .name("ic-audio-worker".into())
        .spawn(move || {
            let mut resampler = match resample::MonoResampler::new(native_rate, TARGET_SAMPLE_RATE)
            {
                Ok(r) => {
                    tracing::info!(from = native_rate, to = TARGET_SAMPLE_RATE, "resampler initialized");
                    r
                }
                Err(err) => {
                    let msg = format!("Could not initialise resampler: {err}");
                    state.set_state(CaptureState::Error, Some(msg.clone()));
                    state.broadcast_error(&msg);
                    return;
                }
            };

            let mut mono: Vec<f32> = Vec::with_capacity(4096);
            let mut resampled: Vec<f32> = Vec::with_capacity(4096);
            let mut carry: Vec<f32> = Vec::with_capacity(PACKET_SAMPLES * 2);
            let mut bytes: Vec<u8> = Vec::with_capacity(PACKET_SAMPLES * 2);
            let mut level_acc: Vec<f32> = Vec::with_capacity(TARGET_SAMPLE_RATE as usize / 4);
            let mut last_level = Instant::now();
            let mut announced_capturing = false;
            // Development build mode: a readable heartbeat of the native path.
            let dev = crate::logging::dev_diagnostics();
            let mut last_diag = Instant::now();

            while !stop.load(Ordering::Relaxed) {
                let block = match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(block) => block,
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        state.evaluate_silence();
                        continue;
                    }
                    Err(_) => break,
                };
                state
                    .counters
                    .frames_captured
                    .fetch_add((block.len() / channels.max(1) as usize) as u64, Ordering::Relaxed);

                mono.clear();
                resample::downmix(&block, channels, &mut mono);
                resampled.clear();
                if let Err(err) = resampler.process(&mono, &mut resampled) {
                    tracing::warn!(error = %err, "resample failure");
                    continue;
                }
                level_acc.extend_from_slice(&resampled);
                carry.extend_from_slice(&resampled);

                let forwarding = !paused.load(Ordering::Relaxed);
                while carry.len() >= PACKET_SAMPLES {
                    let packet: Vec<f32> = carry.drain(..PACKET_SAMPLES).collect();
                    if !forwarding {
                        continue;
                    }
                    bytes.clear();
                    resample::to_linear16_le(&packet, &mut bytes);
                    if state.tx.send(OutMsg::Pcm(bytes.clone())).is_ok() {
                        state.counters.packets_sent.fetch_add(1, Ordering::Relaxed);
                        state
                            .counters
                            .bytes_sent
                            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    }
                    if !announced_capturing {
                        announced_capturing = true;
                        state.set_state(CaptureState::Capturing, None);
                    }
                }

                if last_level.elapsed() >= LEVEL_INTERVAL {
                    let level = resample::rms(&level_acc).min(1.0);
                    level_acc.clear();
                    last_level = Instant::now();
                    state.note_level(level);
                    let _ = state.tx.send(OutMsg::Text(
                        serde_json::json!({ "type": "audio_level", "level": level }).to_string(),
                    ));
                    // The existing browser bridge listens for `level`.
                    let _ = state.tx.send(OutMsg::Text(
                        serde_json::json!({ "type": "level", "level": level }).to_string(),
                    ));
                    state.evaluate_silence();
                }
            }

            tracing::info!("capture stopped; worker exiting");
            if !matches!(state.read().state, CaptureState::Error) {
                state.set_state(CaptureState::Paired, None);
            }
            let _ = state.tx.send(OutMsg::Text(
                serde_json::json!({ "type": "capture_stopped" }).to_string(),
            ));
        })
        .ok();
}

pub fn stop_capture(state: &Shared) {
    let stop: Option<Arc<AtomicBool>> = state.capture_stop.write().take();
    if let Some(flag) = stop {
        state.set_state(CaptureState::Stopping, None);
        flag.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(60));
        state.capture_paused.store(false, Ordering::Relaxed);
        state.note_level(0.0);
    }
}

pub fn set_paused(state: &Shared, paused: bool) {
    state.capture_paused.store(paused, Ordering::Relaxed);
    if state.capture_stop.read().is_some() {
        state.set_state(
            if paused { CaptureState::Paused } else { CaptureState::Capturing },
            None,
        );
    }
}
