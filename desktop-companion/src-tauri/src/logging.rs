//! Structured local logging. Never logs tokens, secrets, transcripts or PCM.
//!
//! Two modes:
//!
//! * **normal** — rolling JSON file + compact console line.
//! * **dev diagnostics** — enabled by a debug build, the `dev-diagnostics`
//!   cargo feature, or `COMPANION_DEV_DIAG=1`. Adds a wide, human-readable
//!   console layer (target, file:line, thread, uptime) plus a banner, so the
//!   native audio path can be read at a glance during Windows bring-up.

use std::path::PathBuf;

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// True when the build/run wants verbose, human-readable native diagnostics.
pub fn dev_diagnostics() -> bool {
    if cfg!(feature = "dev-diagnostics") {
        return true;
    }
    match std::env::var("COMPANION_DEV_DIAG") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "off")
        }
        Err(_) => cfg!(debug_assertions),
    }
}

pub fn init(log_dir: PathBuf) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let _ = std::fs::create_dir_all(&log_dir);
    let appender = tracing_appender::rolling::daily(&log_dir, "companion.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let dev = dev_diagnostics();
    let default_filter = if dev {
        "debug,interviewcopilot_companion=trace,hyper=info,tao=info,wry=info"
    } else {
        "info,interviewcopilot_companion=debug"
    };
    let filter =
        EnvFilter::try_from_env("COMPANION_LOG").unwrap_or_else(|_| EnvFilter::new(default_filter));

    let file_layer = fmt::layer()
        .with_target(true)
        .with_ansi(false)
        .json()
        .with_writer(writer);

    let console_layer = fmt::layer()
        .with_target(dev)
        .with_file(dev)
        .with_line_number(dev)
        .with_thread_names(dev)
        .with_ansi(true);

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(console_layer)
        .init();

    if dev {
        tracing::info!(
            version = crate::state::COMPANION_VERSION,
            os = crate::platform::os_key(),
            capture_backend = crate::platform::backend_name(),
            log_dir = %log_dir.display(),
            profile = if cfg!(debug_assertions) { "debug" } else { "release" },
            "DEV DIAGNOSTICS ON — verbose native audio logging enabled"
        );
    } else {
        tracing::info!(version = crate::state::COMPANION_VERSION, "application start");
    }
    Some(guard)
}
