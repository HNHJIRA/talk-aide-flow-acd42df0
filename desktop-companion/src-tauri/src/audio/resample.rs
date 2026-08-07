//! Streaming resampler: native rate -> 16 kHz mono, high quality (rubato).

use anyhow::Result;
use rubato::{FastFixedIn, PolynomialDegree, Resampler};

pub struct MonoResampler {
    inner: Option<FastFixedIn<f32>>,
    chunk: usize,
    pending: Vec<f32>,
    out_scratch: Vec<Vec<f32>>,
}

impl MonoResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Result<Self> {
        if input_rate == output_rate {
            return Ok(Self { inner: None, chunk: 0, pending: Vec::new(), out_scratch: Vec::new() });
        }
        let chunk = 1024usize;
        let resampler = FastFixedIn::<f32>::new(
            output_rate as f64 / input_rate as f64,
            1.1,
            PolynomialDegree::Septic,
            chunk,
            1,
        )?;
        Ok(Self {
            inner: Some(resampler),
            chunk,
            pending: Vec::with_capacity(chunk * 2),
            out_scratch: vec![Vec::new()],
        })
    }

    /// Feed mono samples, receive whatever full output is currently available.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) -> Result<()> {
        let Some(resampler) = self.inner.as_mut() else {
            out.extend_from_slice(input);
            return Ok(());
        };
        self.pending.extend_from_slice(input);
        while self.pending.len() >= self.chunk {
            let block: Vec<f32> = self.pending.drain(..self.chunk).collect();
            let processed = resampler.process(&[block], None)?;
            if let Some(channel) = processed.into_iter().next() {
                out.extend_from_slice(&channel);
            }
        }
        self.out_scratch.clear();
        Ok(())
    }
}

/// Interleaved multi-channel -> mono average.
pub fn downmix(interleaved: &[f32], channels: u16, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let ch = channels as usize;
    for frame in interleaved.chunks_exact(ch) {
        let sum: f32 = frame.iter().sum();
        out.push(sum / ch as f32);
    }
}

/// Clamp and convert to signed 16-bit little-endian PCM.
pub fn to_linear16_le(samples: &[f32], out: &mut Vec<u8>) {
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}
