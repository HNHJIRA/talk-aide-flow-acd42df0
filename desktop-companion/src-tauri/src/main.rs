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
mod platform;
mod security;
mod state;

use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};

use state::{AppState, CaptureState, CaptureTarget, Pairing, Shared};

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

fn main() {
    let shared = AppState::new(bridge::CANDIDATE_PORTS[0]);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shared.clone())
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
            export_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("error while running InterviewCopilot Companion");
}
