//! Native render client for the interpreter output path.
//!
//! Windows -> WASAPI (shared mode) and macOS -> CoreAudio, both reached
//! through `cpal`, which opens exactly those APIs. This file is used ONLY by
//! the interpreter output worker; capture (WASAPI loopback / ScreenCaptureKit)
//! is a different code path with no shared state.
//!
//! Thread rules:
//!   * the router is created on the `ic-audio-output` worker thread and never
//!     moves (`cpal::Stream` is `!Send`, so this is enforced by the compiler),
//!   * COM is initialised by the WASAPI backend on that same thread,
//!   * the only thing shared with the device callback is a plain
//!     `Arc<Mutex<VecDeque<f32>>>` jitter buffer — no device objects.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

use super::{looks_virtual, resample_linear, OutputDevice, OUTPUT_STATS};

/// Audio held back before playback starts, to absorb network jitter.
const PREBUFFER_MS: u32 = 120;
/// Hard ceiling on queued audio; older speech is dropped past this point.
const MAX_BUFFER_MS: u32 = 1_500;

struct Jitter {
    buf: VecDeque<f32>,
    primed: bool,
    rate: u32,
    channels: usize,
}

impl Jitter {
    fn prebuffer_samples(&self) -> usize {
        (self.rate as usize * PREBUFFER_MS as usize) / 1000
    }
    fn max_samples(&self) -> usize {
        (self.rate as usize * MAX_BUFFER_MS as usize) / 1000
    }
}

#[derive(Default)]
pub struct CpalOutputRouter {
    backend: &'static str,
    stream: Option<cpal::Stream>,
    jitter: Option<Arc<Mutex<Jitter>>>,
    input_rate: u32,
    device_rate: u32,
    opened_at: Option<Instant>,
}

impl CpalOutputRouter {
    pub fn new(backend: &'static str) -> Self {
        Self { backend, ..Default::default() }
    }

    fn pick_device(host: &cpal::Host, device_id: &str) -> Result<cpal::Device> {
        if device_id.is_empty() || device_id == "default" {
            return host
                .default_output_device()
                .ok_or_else(|| anyhow!("No default audio output device is available."));
        }
        let wanted = device_id.to_lowercase();
        let devices = host.output_devices()?;
        for device in devices {
            let name = device.name().unwrap_or_default();
            if name.to_lowercase() == wanted || name.to_lowercase().contains(&wanted) {
                return Ok(device);
            }
        }
        host.default_output_device()
            .ok_or_else(|| anyhow!("Audio output device \"{device_id}\" was not found."))
    }
}

impl super::AudioOutputRouter for CpalOutputRouter {
    fn backend_name(&self) -> &'static str {
        self.backend
    }

    fn enumerate_devices(&self) -> Vec<OutputDevice> {
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|d| d.name().ok())
            .unwrap_or_default();
        match host.output_devices() {
            Ok(devices) => devices
                .filter_map(|d| d.name().ok())
                .map(|name| OutputDevice {
                    virtual_device: looks_virtual(&name),
                    default_device: name == default_name,
                    id: name.clone(),
                    label: name,
                })
                .collect(),
            Err(err) => {
                tracing::warn!(error = %err, "interpreter output: device enumeration failed");
                Vec::new()
            }
        }
    }

    fn open(&mut self, device_id: &str, sample_rate: u32) -> Result<()> {
        self.close();

        let host = cpal::default_host();
        let device = Self::pick_device(&host, device_id)?;
        let name = device.name().unwrap_or_else(|_| "unknown".into());
        let config = device.default_output_config()?;
        let channels = config.channels() as usize;
        let device_rate = config.sample_rate().0;

        let jitter = Arc::new(Mutex::new(Jitter {
            buf: VecDeque::new(),
            primed: false,
            rate: device_rate,
            channels,
        }));

        let sink = jitter.clone();
        let err_sink = |err| {
            *OUTPUT_STATS.last_error.write() = format!("{err}");
            tracing::warn!(error = %err, "interpreter output stream error");
        };

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config.clone().into(),
                move |data: &mut [f32], _| fill(&sink, data),
                err_sink,
                None,
            )?,
            cpal::SampleFormat::I16 => device.build_output_stream(
                &config.clone().into(),
                move |data: &mut [i16], _| {
                    let mut tmp = vec![0.0f32; data.len()];
                    fill(&sink, &mut tmp);
                    for (dst, src) in data.iter_mut().zip(tmp) {
                        *dst = (src.clamp(-1.0, 1.0) * 32767.0) as i16;
                    }
                },
                err_sink,
                None,
            )?,
            cpal::SampleFormat::U16 => device.build_output_stream(
                &config.clone().into(),
                move |data: &mut [u16], _| {
                    let mut tmp = vec![0.0f32; data.len()];
                    fill(&sink, &mut tmp);
                    for (dst, src) in data.iter_mut().zip(tmp) {
                        *dst = ((src.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32) as u16;
                    }
                },
                err_sink,
                None,
            )?,
            other => return Err(anyhow!("Unsupported output sample format: {other:?}")),
        };
        stream.play()?;

        self.stream = Some(stream);
        self.jitter = Some(jitter);
        self.input_rate = sample_rate.max(8_000);
        self.device_rate = device_rate;
        self.opened_at = Some(Instant::now());

        OUTPUT_STATS.sample_rate_in.store(self.input_rate, Ordering::Relaxed);
        OUTPUT_STATS.sample_rate_out.store(device_rate, Ordering::Relaxed);
        OUTPUT_STATS
            .buffer_frames
            .store((device_rate * PREBUFFER_MS) / 1000, Ordering::Relaxed);
        *OUTPUT_STATS.device.write() = name.clone();
        tracing::info!(
            device = %name,
            device_rate,
            channels,
            input_rate = self.input_rate,
            "interpreter output opened (render only; capture untouched)"
        );
        Ok(())
    }

    fn write(&mut self, samples: &[f32]) -> Result<()> {
        let Some(jitter) = self.jitter.as_ref() else {
            return Err(anyhow!("Interpreter output is not open."));
        };
        let resampled = resample_linear(samples, self.input_rate, self.device_rate);
        let mut guard = jitter.lock();
        let max = guard.max_samples();
        for sample in resampled {
            guard.buf.push_back(sample);
        }
        if guard.buf.len() > max {
            let excess = guard.buf.len() - max;
            guard.buf.drain(0..excess);
            OUTPUT_STATS.dropped_frames.fetch_add(excess as u64, Ordering::Relaxed);
        }
        let prebuffer = guard.prebuffer_samples();
        if !guard.primed && guard.buf.len() >= prebuffer {
            guard.primed = true;
        }
        let buffered_ms = (guard.buf.len() as u64 * 1000 / guard.rate.max(1) as u64) as u32;
        OUTPUT_STATS.buffered_ms.store(buffered_ms, Ordering::Relaxed);
        OUTPUT_STATS
            .latency_ms
            .store(buffered_ms + PREBUFFER_MS, Ordering::Relaxed);
        Ok(())
    }

    fn close(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.pause();
        }
        self.jitter = None;
        self.opened_at = None;
        OUTPUT_STATS.buffered_ms.store(0, Ordering::Relaxed);
    }
}

/// Device callback. Underrun protection: never block, never allocate beyond a
/// drain, and write silence when the jitter buffer is empty.
fn fill(jitter: &Arc<Mutex<Jitter>>, data: &mut [f32]) {
    let mut guard = jitter.lock();
    let channels = guard.channels.max(1);
    let frames = data.len() / channels;
    if !guard.primed {
        data.iter_mut().for_each(|s| *s = 0.0);
        return;
    }
    let mut starved = false;
    for frame in 0..frames {
        let sample = match guard.buf.pop_front() {
            Some(value) => value,
            None => {
                starved = true;
                0.0
            }
        };
        for channel in 0..channels {
            data[frame * channels + channel] = sample;
        }
    }
    if starved {
        // Re-prime so the next utterance starts cleanly instead of stuttering.
        guard.primed = false;
        OUTPUT_STATS.underruns.fetch_add(1, Ordering::Relaxed);
    }
    OUTPUT_STATS.frames_out.fetch_add(frames as u64, Ordering::Relaxed);
}
