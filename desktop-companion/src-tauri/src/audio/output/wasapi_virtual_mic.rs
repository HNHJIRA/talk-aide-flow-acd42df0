//! Windows interpreter output (WASAPI shared-mode render client).
//!
//! Thread confinement: created inside the `ic-audio-output` worker thread and
//! never crossing a thread boundary, so COM apartment rules hold by
//! construction. There is deliberately no `unsafe impl Send/Sync`.
//!
//! Existing WASAPI *loopback capture* for meeting audio is untouched: this is
//! a render-only path with its own device, its own buffer and its own worker.

use anyhow::Result;

use super::render::CpalOutputRouter;
use super::{AudioOutputRouter, OutputDevice};

pub struct WasapiOutputRouter {
    inner: CpalOutputRouter,
}

impl Default for WasapiOutputRouter {
    fn default() -> Self {
        Self { inner: CpalOutputRouter::new("wasapi-render") }
    }
}

impl AudioOutputRouter for WasapiOutputRouter {
    fn backend_name(&self) -> &'static str {
        "wasapi-render"
    }

    fn enumerate_devices(&self) -> Vec<OutputDevice> {
        self.inner.enumerate_devices()
    }

    fn open(&mut self, device_id: &str, sample_rate: u32) -> Result<()> {
        self.inner.open(device_id, sample_rate)
    }

    fn write(&mut self, samples: &[f32]) -> Result<()> {
        self.inner.write(samples)
    }

    fn close(&mut self) {
        self.inner.close();
    }
}
