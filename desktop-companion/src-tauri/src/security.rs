//! Origin allow-listing and bridge-token validation.
//!
//! The companion holds NO platform secrets. The only credential it ever sees is
//! the short-lived, session-scoped bridge token released by the web app after
//! the user approves a pairing code.

use crate::state::Shared;

/// Production + preview origins of the InterviewCopilot web app.
const PRODUCTION_ORIGINS: &[&str] = &["https://talk-aide-flow.lovable.app"];

/// Suffix match for Lovable preview deployments of the same project.
const ALLOWED_ORIGIN_SUFFIXES: &[&str] = &[".lovable.app"];

/// Explicitly configured development origin (set via COMPANION_DEV_ORIGIN).
fn dev_origin() -> Option<String> {
    std::env::var("COMPANION_DEV_ORIGIN").ok().filter(|v| !v.is_empty())
}

pub fn web_api_base() -> String {
    std::env::var("COMPANION_API_BASE")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| PRODUCTION_ORIGINS[0].to_string())
}

pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        // A browser always sends Origin on a WebSocket handshake. A missing
        // Origin means a non-browser client; refuse rather than guess.
        return false;
    };
    if PRODUCTION_ORIGINS.contains(&origin) {
        return true;
    }
    if let Some(dev) = dev_origin() {
        if origin == dev {
            return true;
        }
    }
    if let Ok(url) = url_host(origin) {
        if ALLOWED_ORIGIN_SUFFIXES.iter().any(|s| url.ends_with(s)) && origin.starts_with("https://")
        {
            return true;
        }
    }
    false
}

fn url_host(origin: &str) -> Result<String, ()> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .ok_or(())?;
    Ok(rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("").to_string())
}

/// Constant-time-ish comparison against the currently paired bridge token.
pub fn token_valid(state: &Shared, token: &str) -> bool {
    let inner = state.read();
    let Some(pairing) = inner.pairing.as_ref() else {
        return false;
    };
    let expected = pairing.bridge_token.as_bytes();
    let given = token.as_bytes();
    if expected.len() != given.len() || expected.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(given.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}
