//! macOS interpreter output (CoreAudio output unit).
//!
//! ScreenCaptureKit capture is untouched: this is a separate output-only
//! layer, created on and confined to the `ic-audio-output` worker thread.

use anyhow::Result;

use super::render::CpalOutputRouter;
use super::{AudioOutputRouter, OutputDevice};

pub struct CoreAudioOutputRouter {
    inner: CpalOutputRouter,
}

impl Default for CoreAudioOutputRouter {
    fn default() -> Self {
        Self { inner: CpalOutputRouter::new("coreaudio-render") }
    }
}

impl AudioOutputRouter for CoreAudioOutputRouter {
    fn backend_name(&self) -> &'static str {
        "coreaudio-render"
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
