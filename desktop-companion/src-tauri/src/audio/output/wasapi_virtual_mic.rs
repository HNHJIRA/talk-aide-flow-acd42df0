//! Windows output routing for Voice Interpreter Mode (WASAPI render side).
//!
//! Thread confinement: this type is created inside the `ic-audio-output`
//! worker thread and never crosses a thread boundary, so COM apartment rules
//! hold by construction. There is deliberately no `unsafe impl Send/Sync`.
//!
//! Current status: the companion does not yet ship its own WASAPI render
//! client. The interpreted voice is routed by the web app through the selected
//! system output device (a virtual audio cable such as VB-CABLE / VoiceMeeter),
//! which Zoom / Teams then use as a microphone. This module owns the seam that
//! a native render client will be dropped into, and reports honestly until
//! then instead of pretending audio was played.

use anyhow::Result;

use super::{AudioOutputRouter, OutputDevice};

#[derive(Default)]
pub struct WasapiOutputRouter {
    device_id: String,
    sample_rate: u32,
    warned: bool,
}

impl AudioOutputRouter for WasapiOutputRouter {
    fn backend_name(&self) -> &'static str {
        "wasapi-virtual-mic"
    }

    fn enumerate_devices(&self) -> Vec<OutputDevice> {
        // Device discovery for the picker is done in the browser via
        // `mediaDevices.enumerateDevices()`, which lists the same WASAPI
        // render endpoints and, unlike this process, can actually route to
        // them today.
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
                "native WASAPI render is not enabled in this build; \
                 select the virtual cable as the output device in the web app"
            );
        }
        Ok(())
    }

    fn close(&mut self) {
        self.device_id.clear();
        self.sample_rate = 0;
    }
}
