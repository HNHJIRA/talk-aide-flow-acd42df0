//! Localhost bridge: `GET /health` + `ws://127.0.0.1:8765/bridge`.
//!
//! Bound to 127.0.0.1 only. Never 0.0.0.0.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::audio;
use crate::security;
use crate::state::{CaptureState, CaptureTarget, OutMsg, Shared, TARGET_SAMPLE_RATE};

/// Ports probed by the web client, in order.
pub const CANDIDATE_PORTS: [u16; 3] = [8765, 8766, 8767];

pub async fn serve(state: Shared) -> anyhow::Result<u16> {
    for port in CANDIDATE_PORTS {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                state.write().port = port;
                tracing::info!(port, "bridge start (127.0.0.1 only)");
                let app = router(state.clone());
                tokio::spawn(async move {
                    if let Err(err) = axum::serve(listener, app).await {
                        tracing::error!(error = %err, "bridge server stopped");
                    }
                });
                return Ok(port);
            }
            Err(err) => {
                tracing::warn!(port, error = %err, "port unavailable, trying next");
            }
        }
    }
    anyhow::bail!("Ports 8765-8767 are all in use; close the other application and restart.")
}

fn router(state: Shared) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/bridge", get(bridge_upgrade))
        .with_state(state)
}

fn cors_headers(origin: Option<&HeaderValue>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let allow = origin
        .and_then(|o| o.to_str().ok())
        .filter(|o| security::origin_allowed(Some(o)))
        .map(|o| o.to_string());
    if let Some(origin) = allow {
        if let Ok(v) = HeaderValue::from_str(&origin) {
            headers.insert("access-control-allow-origin", v);
        }
    }
    headers.insert("access-control-allow-headers", HeaderValue::from_static("content-type"));
    headers.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers
}

/// Non-sensitive only: never tokens, never audio.
async fn health(State(state): State<Shared>, headers: HeaderMap) -> Response {
    tracing::debug!("health request");
    let inner = state.read();
    let body = json!({
        "status": "ok",
        "app": crate::state::COMPANION_APP_ID,
        "productName": "InterviewCopilot Companion",
        "version": crate::state::COMPANION_VERSION,
        "protocolVersion": crate::state::BRIDGE_PROTOCOL_VERSION,
        "os": crate::platform::os_key(),
        "platform": crate::platform::os_key(),
        "captureBackend": crate::platform::backend_name(),
        "outputBackend": crate::audio::output::backend_name(),
        "captureState": inner.state.as_str(),
        "paired": inner.pairing.is_some(),
    });
    drop(inner);
    (StatusCode::OK, cors_headers(headers.get("origin")), Json(body)).into_response()
}

async fn bridge_upgrade(
    State(state): State<Shared>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    if !security::origin_allowed(origin) {
        tracing::warn!(origin = ?origin, "bridge connection refused: origin not allowed");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Shared) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sender, mut receiver) = socket.split();
    let mut authed = false;

    // Everything the app broadcasts (state / level / format / PCM).
    let mut rx = state.tx.subscribe();
    let (local_tx, mut local_rx) = tokio::sync::mpsc::channel::<Message>(256);

    let pump = tokio::spawn(async move {
        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Ok(OutMsg::Text(text)) => { if sender.send(Message::Text(text)).await.is_err() { break; } }
                    Ok(OutMsg::Pcm(bytes)) => { if sender.send(Message::Binary(bytes)).await.is_err() { break; } }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                },
                direct = local_rx.recv() => match direct {
                    Some(msg) => { if sender.send(msg).await.is_err() { break; } }
                    None => break,
                }
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        // Binary frames are interpreter OUTPUT audio only (PCM16 LE mono).
        // Meeting capture never sends browser -> companion binary.
        if let Message::Binary(bytes) = msg {
            if authed {
                state.output.write_pcm16(&bytes);
            }
            continue;
        }
        let Message::Text(text) = msg else {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if !authed {
            if kind != "auth" && kind != "pair" {
                let _ = local_tx
                    .send(Message::Text(
                        json!({ "type": "error", "message": "Authenticate first." }).to_string(),
                    ))
                    .await;
                continue;
            }
            let token = value
                .get("token")
                .or_else(|| value.get("bridgeToken"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !security::token_valid(&state, token) {
                tracing::warn!("pair failure: invalid or expired bridge token");
                let _ = local_tx
                    .send(Message::Text(
                        json!({ "type": "error", "message": "This pairing is not valid for the companion. Approve the pairing code in the companion window." }).to_string(),
                    ))
                    .await;
                break;
            }
            authed = true;
            {
                let mut inner = state.write();
                inner.bridge_connected = true;
                inner.last_browser_seen = Some(std::time::Instant::now());
            }
            tracing::info!("pair success: browser authenticated");
            let _ = local_tx
                .send(Message::Text(
                    json!({
                        "type": "auth_ok",
                        "version": crate::state::COMPANION_VERSION,
                        "protocolVersion": crate::state::BRIDGE_PROTOCOL_VERSION,
                        "sampleRate": TARGET_SAMPLE_RATE,
                    })
                    .to_string(),
                ))
                .await;
            let _ = local_tx
                .send(Message::Text(json!({ "type": "paired" }).to_string()))
                .await;
            if state.read().state == CaptureState::Idle {
                state.set_state(CaptureState::Paired, None);
            }
            state.broadcast_state();
            continue;
        }

        match kind {
            "start_capture" => {
                let target = value
                    .get("target")
                    .and_then(|v| v.as_str())
                    .map(CaptureTarget::parse)
                    .unwrap_or(CaptureTarget::Zoom);
                tracing::info!(target = target.as_str(), "capture requested");
                let s = state.clone();
                let sent = local_tx.clone();
                tokio::task::spawn_blocking(move || audio::start_capture(&s, target))
                    .await
                    .ok();
                let _ = sent
                    .send(Message::Text(json!({ "type": "capture_started" }).to_string()))
                    .await;
                state.broadcast_format();
            }
            "stop_capture" => {
                let s = state.clone();
                tokio::task::spawn_blocking(move || audio::stop_capture(&s)).await.ok();
                let _ = local_tx
                    .send(Message::Text(json!({ "type": "capture_stopped" }).to_string()))
                    .await;
            }
            "pause_capture" => {
                audio::set_paused(&state, true);
                tracing::info!("capture paused");
            }
            "resume_capture" => {
                audio::set_paused(&state, false);
                tracing::info!("capture resumed");
            }
            "get_status" => {
                let mut snap = state.snapshot();
                snap["type"] = json!("status");
                let _ = local_tx.send(Message::Text(snap.to_string())).await;
            }
            // Voice Interpreter Mode: OUTPUT-only path. Never touches capture.
            "interpreter_output_open" => {
                let device = value.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
                let rate = value
                    .get("sampleRate")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(TARGET_SAMPLE_RATE as u64) as u32;
                state.output.open(device, rate);
                let _ = local_tx
                    .send(Message::Text(
                        json!({
                            "type": "interpreter_output_open",
                            "backend": crate::audio::output::backend_name(),
                            "deviceId": device,
                            "sampleRate": rate,
                        })
                        .to_string(),
                    ))
                    .await;
            }
            "interpreter_output_pcm" => {
                if let Some(arr) = value.get("samples").and_then(|v| v.as_array()) {
                    let samples: Vec<f32> =
                        arr.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect();
                    state.output.write(samples);
                }
            }
            "interpreter_output_devices" => {
                let devices = crate::audio::output::enumerate_devices();
                let _ = local_tx
                    .send(Message::Text(
                        json!({ "type": "interpreter_output_devices", "devices": devices })
                            .to_string(),
                    ))
                    .await;
            }
            "interpreter_output_stats" => {
                let mut snap = crate::audio::output::stats().snapshot();
                snap["type"] = json!("interpreter_output_stats");
                let _ = local_tx.send(Message::Text(snap.to_string())).await;
            }
            "interpreter_output_close" => {
                state.output.close();
            }
            "ping" => {
                let _ = local_tx.send(Message::Text(json!({ "type": "pong" }).to_string())).await;
            }
            // Private Overlay control + content frames. These never touch audio;
            // they are forwarded verbatim to the native overlay window.
            k if k.starts_with("overlay_") => {
                let _ = state.overlay_tx.send(value.clone());
            }
            _ => {}
        }
        state.write().last_browser_seen = Some(std::time::Instant::now());
    }

    pump.abort();
    {
        let mut inner = state.write();
        inner.bridge_connected = false;
    }
    tracing::info!("bridge disconnected");

    // Grace period: never keep capturing without an authorised web session.
    if authed {
        let state2 = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            if !state2.read().bridge_connected && state2.capture_stop.read().is_some() {
                tracing::warn!("no authorised browser session; stopping capture");
                let s = state2.clone();
                tokio::task::spawn_blocking(move || audio::stop_capture(&s)).await.ok();
                state2.capture_paused.store(false, Ordering::Relaxed);
            }
        });
    }
}
