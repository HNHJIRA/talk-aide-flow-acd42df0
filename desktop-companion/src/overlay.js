/**
 * Private Overlay renderer.
 *
 * Receives read-only snapshots pushed by the paired InterviewCopilot tab via the
 * Rust bridge. It never fetches anything and holds no credentials.
 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const MODES = ["bubble", "mini", "focus"];
let mode = "mini";

const PHASES = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  answering: "answering…",
  paused: "paused",
};

function setMode(next) {
  mode = MODES.includes(next) ? next : "mini";
  document.body.className = `mode-${mode}${document.body.classList.contains("live") ? " live" : ""}`;
}

function mmss(total) {
  const s = Math.max(0, Math.round(total || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function render(s) {
  document.body.classList.toggle("live", Boolean(s.live));
  $("question").textContent = s.question || "Waiting for the interviewer…";
  $("answer").textContent =
    s.answer || (s.answerStatus === "generating" ? "…" : s.answerStatus === "error" ? "Answer failed." : "—");
  $("phase").textContent = PHASES[s.phase] ?? "";
  $("counter").textContent = `${s.total ? s.index : 0} / ${s.total || 0}`;
  $("source").textContent = [s.source, s.micLabel].filter(Boolean).join(" · ");
  $("timer").textContent = mmss(s.elapsed);
  $("meta").textContent = s.sessionTitle || "";
  // Keep the newest streamed text in view in focus mode.
  if (mode === "focus" && s.answerStatus === "generating") {
    $("body").scrollTop = $("body").scrollHeight;
  }
}

listen("overlay://update", (event) => render(event.payload));
listen("overlay://mode", (event) => setMode(event.payload));
listen("overlay://opacity", (event) => {
  document.body.style.opacity = String(event.payload ?? 1);
});
listen("overlay://fields", (event) => {
  document.body.dataset.fields = event.payload ?? "both";
});
listen("overlay://lock", () => {});

$("btnHide").addEventListener("click", () => invoke("overlay_hide"));
$("btnBubble").addEventListener("click", () => invoke("overlay_set_mode", { mode: "bubble" }));
$("btnCycle").addEventListener("click", () => {
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  invoke("overlay_set_mode", { mode: next });
});
$("bubble").addEventListener("dblclick", () => invoke("overlay_set_mode", { mode: "mini" }));
$("btnNext").addEventListener("click", () => invoke("overlay_command", { action: "next" }));
$("btnPrev").addEventListener("click", () => invoke("overlay_command", { action: "prev" }));

setMode("mini");
