//! macOS output routing for Voice Interpreter Mode (CoreAudio render side).
//!
//! ScreenCaptureKit capture is untouched: this is a separate output-only
//! layer, created on and confined to the `ic-audio-output` worker thread.
//!
//! Current status: the companion does not yet ship its own CoreAudio output
//! unit or a virtual audio driver (a signed HAL plug-in is a separate,
//! notarised installer). The interpreted voice is routed by the web app to a
//! virtual device such as BlackHole or Loopback, which Zoom / Teams then use
//! as a microphone. This module owns the seam a native output unit will be
//! dropped into and reports honestly until then.

use anyhow::Result;

use super::{AudioOutputRouter, OutputDevice};

#[derive(Default)]
pub struct CoreAudioOutputRouter {
    device_id: String,
    sample_rate: u32,
    warned: bool,
}

impl AudioOutputRouter for CoreAudioOutputRouter {
    fn backend_name(&self) -> &'static str {
        "coreaudio-virtual-mic"
    }

    fn enumerate_devices(&self) -> Vec<OutputDevice> {
        // The browser enumerates the same CoreAudio output devices and can
        // route to them today, so the picker is driven from there.
        Vec::new()
    }

    fn open(&mut self, device_id: &str, sample_rate: u32) -> Result<()> {
        self.device_id = device_id.to_string();
        self.sample_rate = sample_rate;
        self.warned = false;
        tracing::info!(
            device = %self.device_id,
            sample_rate,
            "interpreter output requested; routing handled by the browser output device"
        );
        Ok(())
    }

    fn write(&mut self, samples: &[f32]) -> Result<()> {
        if !self.warned {
            self.warned = true;
            tracing::info!(
                samples = samples.len(),
                "native CoreAudio render is not enabled in this build; \
                 select BlackHole / Loopback as the output device in the web app"
            );
        }
        Ok(())
    }

    fn close(&mut self) {
        self.device_id.clear();
        self.sample_rate = 0;
    }
}
