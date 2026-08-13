//! Private Overlay — a native, always-on-top, frameless companion window.
//!
//! The overlay is deliberately dumb: it renders whatever read-only snapshot the
//! authenticated browser pushes over the localhost bridge. It performs no
//! network calls, holds no tokens and never sees audio.
//!
//! Screen-capture privacy:
//!   * Windows  — `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`,
//!     applied by Tauri's `set_content_protected(true)`. Supported on Windows 10
//!     2004+ ; the window stays visible locally but is omitted from
//!     DWM-based capture (Zoom / Teams / Meet screen share, OBS, Snipping Tool).
//!   * macOS    — `NSWindow.sharingType = NSWindowSharingNone`, also applied by
//!     `set_content_protected(true)`. This reliably hides the window from
//!     `CGWindowListCreateImage`-style capture and most sharing paths, but is
//!     best-effort: ScreenCaptureKit full-display capture on some macOS versions
//!     can still include it, so we report it honestly rather than promising it.
//!   * Anything else — unsupported; we say so.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "overlay";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayMode {
    Bubble,
    Mini,
    Focus,
}

impl OverlayMode {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "bubble" => OverlayMode::Bubble,
            "focus" => OverlayMode::Focus,
            _ => OverlayMode::Mini,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            OverlayMode::Bubble => "bubble",
            OverlayMode::Mini => "mini",
            OverlayMode::Focus => "focus",
        }
    }
    /// Logical size presets (small / medium / large).
    pub fn size(self) -> (f64, f64) {
        match self {
            OverlayMode::Bubble => (108.0, 108.0),
            OverlayMode::Mini => (380.0, 220.0),
            OverlayMode::Focus => (520.0, 430.0),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: &'static str,
    pub always_on_top: bool,
    pub capture_exclusion: bool,
    pub capture_exclusion_active: bool,
    pub note: String,
}

pub fn capabilities(active: bool) -> Capabilities {
    #[cfg(target_os = "windows")]
    {
        Capabilities {
            platform: "windows",
            always_on_top: true,
            capture_exclusion: true,
            capture_exclusion_active: active,
            note: if active {
                "Windows: excluded from capture via SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). Visible to you, omitted from Zoom/Teams/Meet screen share and most recorders. Requires Windows 10 2004+; a hardware camera pointed at your screen obviously still sees it."
                    .into()
            } else {
                "Windows: capture exclusion is supported but currently off.".into()
            },
        }
    }
    #[cfg(target_os = "macos")]
    {
        Capabilities {
            platform: "macos",
            always_on_top: true,
            capture_exclusion: true,
            capture_exclusion_active: active,
            note: if active {
                "macOS: NSWindowSharingNone is applied, which hides the overlay from window-list capture and most sharing paths. Best-effort only — some ScreenCaptureKit full-display recorders on newer macOS can still include it, so verify before relying on it."
                    .into()
            } else {
                "macOS: window-sharing exclusion is supported but currently off.".into()
            },
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = active;
        Capabilities {
            platform: "unsupported",
            always_on_top: false,
            capture_exclusion: false,
            capture_exclusion_active: false,
            note: "This platform has no supported always-on-top / capture-exclusion path. Windows and macOS only.".into(),
        }
    }
}

pub struct OverlayPrefs {
    pub mode: OverlayMode,
    pub opacity: f64,
    pub locked: bool,
    pub always_on_top: bool,
    pub hide_from_capture: bool,
    pub visible: bool,
}

impl Default for OverlayPrefs {
    fn default() -> Self {
        Self {
            mode: OverlayMode::Mini,
            opacity: 1.0,
            locked: false,
            always_on_top: true,
            hide_from_capture: true,
            visible: false,
        }
    }
}

pub type SharedPrefs = std::sync::Arc<parking_lot::RwLock<OverlayPrefs>>;

/// Create the overlay window on first use. Idempotent.
pub fn ensure_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(win);
    }
    let (w, h) = OverlayMode::Mini.size();
    let win = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("InterviewCopilot Overlay")
        .inner_size(w, h)
        .min_inner_size(108.0, 108.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;

    let _ = win.set_visible_on_all_workspaces(true);
    // Strongest available OS privacy setting, applied before the window is shown
    // so it is never briefly capturable.
    let _ = win.set_content_protected(true);
    position_default(&win);
    Ok(win)
}

fn position_default(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let (w, _h) = OverlayMode::Mini.size();
        let _ = win.set_position(tauri::LogicalPosition::new(size.width - w - 32.0, 96.0));
    }
}

fn apply(win: &tauri::WebviewWindow, prefs: &OverlayPrefs) {
    let (w, h) = prefs.mode.size();
    let _ = win.set_size(tauri::LogicalSize::new(w, h));
    let _ = win.set_always_on_top(prefs.always_on_top);
    let _ = win.set_content_protected(prefs.hide_from_capture);
    let _ = win.set_ignore_cursor_events(false);
    let _ = win.set_resizable(!prefs.locked);
}

/// Handle one `overlay_*` frame coming from the authenticated browser.
pub fn handle_message(app: &AppHandle, prefs: &SharedPrefs, msg: &Value) {
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let win = match ensure_window(app) {
        Ok(win) => win,
        Err(err) => {
            tracing::error!(error = %err, "overlay window could not be created");
            return;
        }
    };

    match kind {
        "overlay_hello" => {}
        "overlay_update" => {
            if let Some(payload) = msg.get("payload") {
                let _ = app.emit_to(OVERLAY_LABEL, "overlay://update", payload.clone());
            }
            return;
        }
        "overlay_show" => {
            {
                let mut p = prefs.write();
                p.visible = true;
                apply(&win, &p);
            }
            let _ = win.show();
            let _ = app.emit_to(OVERLAY_LABEL, "overlay://mode", json!(prefs.read().mode.as_str()));
        }
        "overlay_hide" => {
            prefs.write().visible = false;
            let _ = win.hide();
        }
        "overlay_mode" => {
            let mode = OverlayMode::parse(msg.get("mode").and_then(|v| v.as_str()).unwrap_or("mini"));
            {
                let mut p = prefs.write();
                p.mode = mode;
                apply(&win, &p);
            }
            let _ = app.emit_to(OVERLAY_LABEL, "overlay://mode", json!(mode.as_str()));
        }
        "overlay_opacity" => {
            let opacity = msg.get("opacity").and_then(|v| v.as_f64()).unwrap_or(1.0).clamp(0.4, 1.0);
            prefs.write().opacity = opacity;
            let _ = app.emit_to(OVERLAY_LABEL, "overlay://opacity", json!(opacity));
        }
        "overlay_lock" => {
            let locked = msg.get("locked").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut p = prefs.write();
            p.locked = locked;
            apply(&win, &p);
            let _ = app.emit_to(OVERLAY_LABEL, "overlay://lock", json!(locked));
        }
        "overlay_always_on_top" => {
            let on = msg.get("alwaysOnTop").and_then(|v| v.as_bool()).unwrap_or(true);
            prefs.write().always_on_top = on;
            let _ = win.set_always_on_top(on);
        }
        "overlay_hide_from_capture" => {
            let hide = msg.get("hide").and_then(|v| v.as_bool()).unwrap_or(true);
            prefs.write().hide_from_capture = hide;
            let _ = win.set_content_protected(hide);
        }
        "overlay_show_fields" => {
            let show = msg.get("show").and_then(|v| v.as_str()).unwrap_or("both").to_string();
            let _ = app.emit_to(OVERLAY_LABEL, "overlay://fields", json!(show));
        }
        "overlay_status" => {}
        _ => return,
    }

    publish_status(app, prefs);
}

/// Report the true window state (including what the OS really supports) back to
/// the web app so its UI never claims a guarantee we cannot keep.
pub fn publish_status(app: &AppHandle, prefs: &SharedPrefs) {
    let state = app.state::<crate::state::Shared>();
    let p = prefs.read();
    let caps = capabilities(p.hide_from_capture);
    state.send_to_browser(json!({
        "type": "overlay_status",
        "status": {
            "visible": p.visible,
            "mode": p.mode.as_str(),
            "opacity": p.opacity,
            "locked": p.locked,
            "capabilities": caps,
        }
    }));
}

/// Shortcut actions handled entirely inside the companion.
pub fn toggle_visibility(app: &AppHandle, prefs: &SharedPrefs) {
    let Ok(win) = ensure_window(app) else { return };
    let visible = prefs.read().visible;
    if visible {
        prefs.write().visible = false;
        let _ = win.hide();
    } else {
        {
            let mut p = prefs.write();
            p.visible = true;
            apply(&win, &p);
        }
        let _ = win.show();
    }
    publish_status(app, prefs);
}

pub fn cycle_mode(app: &AppHandle, prefs: &SharedPrefs) {
    let next = match prefs.read().mode {
        OverlayMode::Bubble => OverlayMode::Mini,
        OverlayMode::Mini => OverlayMode::Focus,
        OverlayMode::Focus => OverlayMode::Bubble,
    };
    handle_message(app, prefs, &json!({ "type": "overlay_mode", "mode": next.as_str() }));
}

pub fn minimise_to_bubble(app: &AppHandle, prefs: &SharedPrefs) {
    handle_message(app, prefs, &json!({ "type": "overlay_mode", "mode": "bubble" }));
}

/// Shortcuts the *web app* must action (it owns the question list).
pub fn request_from_browser(app: &AppHandle, action: &str) {
    let state = app.state::<crate::state::Shared>();
    state.send_to_browser(json!({ "type": "overlay_command", "action": action }));
}
