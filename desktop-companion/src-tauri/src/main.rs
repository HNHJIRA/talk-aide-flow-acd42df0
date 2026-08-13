// InterviewCopilot Desktop Companion.
//
// A small utility whose only job is to hand native meeting audio to the
// InterviewCopilot web app over an authenticated localhost bridge.
// It performs NO transcription, NO AI, NO resume access and holds NO platform
// secrets.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio;
mod bridge;
mod logging;
mod overlay;
mod platform;
mod security;
mod state;

use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};

use state::{AppState, CaptureState, CaptureTarget, Pairing, Shared};

use overlay::SharedPrefs;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    session_id: String,
    #[serde(default)]
    session_title: Option<String>,
    bridge_token: String,
    #[serde(default)]
    expires_at: Option<String>,
}

/// Redeem the 6-character code shown in the web app. The response contains only
/// a session-scoped bridge token — never an API key.
#[tauri::command]
async fn pair(code: String, app_state: TauriState<'_, Shared>) -> Result<serde_json::Value, String> {
    let code = code.trim().to_uppercase();
    if code.len() < 5 {
        return Err("Enter the full pairing code shown in InterviewCopilot.".into());
    }
    tracing::info!("pair attempt");
    let url = format!("{}/api/public/companion/pair", security::web_api_base());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(url)
        .json(&serde_json::json!({
            "code": code,
            "os": platform::os_key(),
            "version": state::COMPANION_VERSION,
        }))
        .send()
        .await
        .map_err(|_| "Could not reach InterviewCopilot. Check your internet connection.".to_string())?;

    if !res.status().is_success() {
        tracing::warn!(status = res.status().as_u16(), "pair failure");
        return Err("That pairing code is invalid or has expired.".into());
    }
    let body: PairResponse = res.json().await.map_err(|e| e.to_string())?;

    {
        let mut inner = app_state.write();
        inner.pairing = Some(Pairing {
            bridge_token: body.bridge_token,
            session_id: body.session_id,
            session_title: body.session_title.unwrap_or_else(|| "Interview session".into()),
            expires_at: body.expires_at.unwrap_or_default(),
            paired_at: std::time::Instant::now(),
        });
    }
    app_state.set_state(CaptureState::Paired, None);
    tracing::info!("pair success");
    Ok(app_state.snapshot())
}

#[tauri::command]
fn unpair(app_state: TauriState<'_, Shared>) -> serde_json::Value {
    audio::stop_capture(&app_state);
    app_state.write().pairing = None;
    app_state.set_state(CaptureState::WaitingForPair, None);
    app_state.snapshot()
}

#[tauri::command]
fn get_status(app_state: TauriState<'_, Shared>) -> serde_json::Value {
    app_state.snapshot()
}

#[tauri::command]
fn list_sources() -> Vec<platform::SourceInfo> {
    platform::enumerate_sources()
}

#[tauri::command]
fn set_preferred_target(target: String, app_state: TauriState<'_, Shared>) -> serde_json::Value {
    app_state.write().preferred_target = CaptureTarget::parse(&target);
    app_state.snapshot()
}

/// LOCAL AUDIO TEST — proves native capture without any Deepgram involvement.
#[tauri::command]
fn start_local_test(app_state: TauriState<'_, Shared>) -> Result<serde_json::Value, String> {
    let target = app_state.read().preferred_target;
    app_state.write().local_test_mode = true;
    audio::start_capture(&app_state, target).map_err(|e| e.to_string())?;
    Ok(app_state.snapshot())
}

#[tauri::command]
fn start_capture_cmd(app_state: TauriState<'_, Shared>) -> Result<serde_json::Value, String> {
    if app_state.read().pairing.is_none() {
        return Err("Pair with InterviewCopilot first.".into());
    }
    let target = app_state.read().preferred_target;
    audio::start_capture(&app_state, target).map_err(|e| e.to_string())?;
    Ok(app_state.snapshot())
}

#[tauri::command]
fn stop_capture_cmd(app_state: TauriState<'_, Shared>) -> serde_json::Value {
    audio::stop_capture(&app_state);
    app_state.write().local_test_mode = false;
    app_state.snapshot()
}

#[tauri::command]
fn set_paused(paused: bool, app_state: TauriState<'_, Shared>) -> serde_json::Value {
    audio::set_paused(&app_state, paused);
    app_state.snapshot()
}

/// Safe export: no tokens, no keys, no audio, no transcripts, no resume data.
#[tauri::command]
fn export_diagnostics(app_state: TauriState<'_, Shared>) -> String {
    serde_json::to_string_pretty(&app_state.diagnostics()).unwrap_or_else(|_| "{}".into())
}

/* ---------------- overlay window commands (called by overlay.html) ---------------- */

#[tauri::command]
fn overlay_set_mode(mode: String, app: AppHandle, prefs: TauriState<'_, SharedPrefs>) {
    overlay::handle_message(
        &app,
        prefs.inner(),
        &serde_json::json!({ "type": "overlay_mode", "mode": mode }),
    );
}

#[tauri::command]
fn overlay_hide(app: AppHandle, prefs: TauriState<'_, SharedPrefs>) {
    overlay::handle_message(&app, prefs.inner(), &serde_json::json!({ "type": "overlay_hide" }));
}

/// Navigation buttons: the web app owns the question list, so we ask it.
#[tauri::command]
fn overlay_command(action: String, app: AppHandle) {
    overlay::request_from_browser(&app, &action);
}

#[tauri::command]
fn overlay_capabilities(prefs: TauriState<'_, SharedPrefs>) -> serde_json::Value {
    let hide = prefs.read().hide_from_capture;
    serde_json::to_value(overlay::capabilities(hide)).unwrap_or_else(|_| serde_json::json!({}))
}

fn main() {
    let shared = AppState::new(bridge::CANDIDATE_PORTS[0]);
    let overlay_prefs: SharedPrefs =
        std::sync::Arc::new(parking_lot::RwLock::new(overlay::OverlayPrefs::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared.clone())
        .manage(overlay_prefs.clone())
        .setup(move |app| {
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("interviewcopilot-companion"));
            let guard = logging::init(log_dir);
            std::mem::forget(guard);

            shared.set_state(CaptureState::WaitingForPair, None);

            // Localhost bridge.
            let bridge_state = shared.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = bridge::serve(bridge_state.clone()).await {
                    let msg = err.to_string();
                    tracing::error!(error = %msg, "bridge failed to start");
                    bridge_state.set_state(CaptureState::Error, Some(msg));
                }
            });

            // Push status to the tiny UI.
            let ui_state = shared.clone();
            let handle: AppHandle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    ui_state.evaluate_silence();
                    let _ = handle.emit("companion://status", ui_state.snapshot());
                }
            });

            // Private Overlay: forward browser frames to the native overlay window.
            let overlay_state = shared.clone();
            let overlay_handle: AppHandle = app.handle().clone();
            let overlay_prefs_task = overlay_prefs.clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = overlay_state.overlay_tx.subscribe();
                loop {
                    match rx.recv().await {
                        Ok(msg) => overlay::handle_message(&overlay_handle, &overlay_prefs_task, &msg),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            // Global shortcuts. Registration failures are non-fatal: the overlay
            // is still controllable from the web app and the tray.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let gs_prefs = overlay_prefs.clone();
                let gs = app.global_shortcut();
                let bindings: [(&str, &str); 5] = [
                    ("CmdOrCtrl+Shift+O", "toggle"),
                    ("CmdOrCtrl+Shift+S", "cycle"),
                    ("CmdOrCtrl+Shift+H", "minimise"),
                    ("CmdOrCtrl+Shift+Period", "next"),
                    ("CmdOrCtrl+Shift+Comma", "prev"),
                ];
                for (accel, action) in bindings {
                    let prefs = gs_prefs.clone();
                    let action = action.to_string();
                    if let Err(err) = gs.on_shortcut(accel, move |app, _shortcut, event| {
                        if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            return;
                        }
                        match action.as_str() {
                            "toggle" => overlay::toggle_visibility(app, &prefs),
                            "cycle" => overlay::cycle_mode(app, &prefs),
                            "minimise" => overlay::minimise_to_bubble(app, &prefs),
                            other => overlay::request_from_browser(app, other),
                        }
                    }) {
                        tracing::warn!(accel, error = %err, "global shortcut unavailable");
                    }
                }
            }

            // Tray: capture status is always visible, never hidden.
            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Capture", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &stop, &quit])?;
            let tray_state = shared.clone();
            TrayIconBuilder::new()
                .tooltip("InterviewCopilot Companion")
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "stop" => audio::stop_capture(&tray_state),
                    "quit" => {
                        tracing::info!("application exit");
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pair,
            unpair,
            get_status,
            list_sources,
            set_preferred_target,
            start_local_test,
            start_capture_cmd,
            stop_capture_cmd,
            set_paused,
            export_diagnostics,
            overlay_set_mode,
            overlay_hide,
            overlay_command,
            overlay_capabilities
        ])
        .run(tauri::generate_context!())
        .expect("error while running InterviewCopilot Companion");
}
