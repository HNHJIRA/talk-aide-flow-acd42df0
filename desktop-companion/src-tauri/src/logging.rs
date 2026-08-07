//! Structured local logging. Never logs tokens, secrets, transcripts or PCM.

use std::path::PathBuf;

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub fn init(log_dir: PathBuf) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let _ = std::fs::create_dir_all(&log_dir);
    let appender = tracing_appender::rolling::daily(&log_dir, "companion.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env("COMPANION_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,interviewcopilot_companion=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_ansi(false).json().with_writer(writer))
        .with(fmt::layer().with_target(false))
        .init();

    tracing::info!(version = crate::state::COMPANION_VERSION, "application start");
    Some(guard)
}
