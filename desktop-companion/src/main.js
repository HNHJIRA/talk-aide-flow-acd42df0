const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const CAPTURE_LABELS = {
  idle: "Stopped",
  waiting_for_pair: "Stopped",
  paired: "Stopped",
  requesting_permission: "Requesting permission…",
  starting: "Starting…",
  capturing: "Capturing",
  silent: "Capturing (silent)",
  paused: "Paused",
  reconnecting: "Reconnecting…",
  error: "Error",
  stopping: "Stopping…",
};

function render(s) {
  $("version").textContent = `v${s.version} · ${s.os} · ${s.captureBackend}`;
  $("status").textContent = s.paired
    ? "Connected to InterviewCopilot"
    : "Waiting for InterviewCopilot";
  $("session").textContent = s.sessionTitle ?? "Not paired";
  $("capture").textContent = CAPTURE_LABELS[s.captureState] ?? s.captureState;

  const active = s.captureState === "capturing" || s.captureState === "silent";
  const dot = $("dot");
  dot.className = "dot" + (active ? " on" : s.captureState === "error" ? " err" : "");
  $("recording").hidden = !active;
  $("meter").style.width = `${Math.min(100, Math.round((s.level ?? 0) * 220))}%`;

  const f = s.format ?? {};
  $("method").textContent = f.captureMethod && f.captureMethod !== "none" ? f.captureMethod : "—";
  $("source").textContent =
    f.sourceProcess ?? (f.deviceName ?? f.device_name ?? (s.sourceDetection ?? "—"));
  $("native").textContent = f.nativeSampleRate
    ? `${f.nativeSampleRate} Hz · ${f.nativeChannels} ch · ${f.nativeFormat ?? ""}`
    : "—";
  $("packets").textContent = `${s.counters.packetsSent} / ${s.counters.bytesSent}`;
  $("drops").textContent = s.counters.audioBufferDrops;
  $("bridge").textContent = `127.0.0.1:${s.port}`;
  $("error").textContent = s.lastError ?? "None";
  $("pair-card").hidden = !!s.paired;
}

listen("companion://status", (event) => render(event.payload));
invoke("get_status").then(render);

$("pair-btn").addEventListener("click", async () => {
  $("pair-error").textContent = "";
  try {
    render(await invoke("pair", { code: $("code").value }));
  } catch (err) {
    $("pair-error").textContent = String(err);
  }
});

$("target").addEventListener("change", async (e) => {
  render(await invoke("set_preferred_target", { target: e.target.value }));
});

$("start").addEventListener("click", async () => {
  try {
    render(await invoke("start_capture_cmd"));
  } catch (err) {
    $("pair-error").textContent = String(err);
  }
});

$("test").addEventListener("click", async () => {
  try {
    render(await invoke("start_local_test"));
  } catch (err) {
    $("pair-error").textContent = String(err);
  }
});

let paused = false;
$("pause").addEventListener("click", async () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  render(await invoke("set_paused", { paused }));
});

$("stop").addEventListener("click", async () => {
  paused = false;
  $("pause").textContent = "Pause";
  render(await invoke("stop_capture_cmd"));
});

$("export").addEventListener("click", async () => {
  const text = await invoke("export_diagnostics");
  const area = $("diag");
  area.hidden = false;
  area.value = text;
  area.select();
});
