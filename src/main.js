import { MODES, simulate, metrics, autoTune, preset, DT } from "./sim.js";

const $ = (id) => document.getElementById(id);
const els = {
  mode: $("mode"), target: $("target"), targetVal: $("targetVal"),
  kP: $("kP"), kI: $("kI"), kD: $("kD"),
  kPnum: $("kPnum"), kInum: $("kInum"), kDnum: $("kDnum"),
  noise: $("noise"), disturb: $("disturb"),
  autotune: $("autotune"), keep: $("keep"), reset: $("reset"), copy: $("copy"),
  chart: $("chart"), metrics: $("metrics"), snippet: $("snippet"),
};

const state = { mode: "drive", target: 24, kP: 0, kI: 0, kD: 0, noise: false, disturbance: false };
let keptRun = null;

// ---- ranges + sync ----
function applyMode() {
  const cfg = MODES[state.mode];
  els.target.min = cfg.targetMin; els.target.max = cfg.targetMax; els.target.step = state.mode === "drive" ? 1 : 5;
  state.target = cfg.target;
  for (const [k, max] of [["kP", cfg.kpMax], ["kI", cfg.kiMax], ["kD", cfg.kdMax]]) {
    els[k].min = 0; els[k].max = max; els[k].step = max / 500;
    els[k + "num"].min = 0; els[k + "num"].max = max;
  }
  // Start P-only so the first view shows a classic uncorrected response.
  state.kP = 2 / cfg.target; state.kI = 0; state.kD = 0;
  keptRun = null;
  syncInputs();
  update();
}
function syncInputs() {
  els.target.value = state.target;
  els.targetVal.textContent = `${state.target} ${MODES[state.mode].unit}`;
  for (const k of ["kP", "kI", "kD"]) {
    els[k].value = state[k];
    els[k + "num"].value = round(state[k]);
  }
}
const round = (n) => Math.round(n * 10000) / 10000;

// ---- chart ----
function draw(run, clean) {
  const c = els.chart, ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cfg = run.cfg, unit = cfg.unit, T = run.target;
  const mL = 46, mR = 12, mT = 12, mB = 28;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const tMax = cfg.duration;
  let yMax = T, yMin = 0;
  const scan = (arr) => arr.forEach((v) => { if (v > yMax) yMax = v; if (v < yMin) yMin = v; });
  scan(run.x); if (keptRun) scan(keptRun.x);
  yMax = yMax * 1.12 + T * 0.05; yMin = Math.min(0, yMin) - T * 0.05;
  const X = (t) => mL + (t / tMax) * plotW;
  const Y = (v) => mT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // grid + axes
  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.fillStyle = "#9b9cc6"; ctx.lineWidth = 1;
  for (let g = 0; g <= 5; g++) {
    const v = yMin + (g / 5) * (yMax - yMin), y = Y(v);
    ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(W - mR, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(v.toFixed(0), mL - 6, y);
  }
  for (let s = 0; s <= tMax + 0.001; s += 0.5) {
    const x = X(s);
    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + plotH); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(s.toFixed(1) + "s", x, mT + plotH + 6);
  }
  ctx.textAlign = "left"; ctx.fillText(unit, mL + 2, mT);

  // 5% settling band
  ctx.fillStyle = "rgba(170,178,255,0.10)";
  const band = 0.05 * Math.abs(T);
  ctx.fillRect(mL, Y(T + band), plotW, Y(T - band) - Y(T + band));
  // setpoint line
  ctx.strokeStyle = "rgba(170,178,255,0.85)"; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(mL, Y(T)); ctx.lineTo(W - mR, Y(T)); ctx.stroke(); ctx.setLineDash([]);

  // disturbance marker
  if (run.distAt != null) {
    ctx.strokeStyle = "rgba(255,109,138,0.7)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(run.distAt), mT); ctx.lineTo(X(run.distAt), mT + plotH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#ff6b8a"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("shove", X(run.distAt), mT + 12);
  }
  // kept run (faded)
  if (keptRun) plotLine(ctx, keptRun.t, keptRun.x, X, Y, "rgba(155,156,198,0.5)", 1.5);
  // noisy measurement (faint) when noise on
  if (state.noise) plotLine(ctx, run.t, run.measured, X, Y, "rgba(110,255,177,0.35)", 1);
  // response (true position)
  plotLine(ctx, run.t, run.x, X, Y, "#aab2ff", 2.4);

  // legend
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  let lx = mL + 8, ly = mT + 12;
  const leg = (color, label) => { ctx.fillStyle = color; ctx.fillRect(lx, ly - 4, 14, 3); ctx.fillStyle = "#ecedf8"; ctx.fillText(label, lx + 20, ly); lx += 28 + ctx.measureText(label).width; };
  leg("#aab2ff", "response"); leg("rgba(170,178,255,0.85)", "setpoint");
  if (keptRun) leg("rgba(155,156,198,0.7)", "kept");
}
function plotLine(ctx, t, y, X, Y, color, w) {
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
  for (let i = 0; i < t.length; i++) { const px = X(t[i]), py = Y(y[i]); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); }
  ctx.stroke();
}

// ---- metrics ----
function renderMetrics(m, unit) {
  const cards = [
    { label: "Rise time", val: m.rise == null ? "—" : m.rise.toFixed(2) + "s", cls: m.rise == null ? "bad" : m.rise < 0.6 ? "good" : m.rise < 1.2 ? "warn" : "bad" },
    { label: "Overshoot", val: m.overshoot.toFixed(0) + "%", cls: m.overshoot < 5 ? "good" : m.overshoot < 20 ? "warn" : "bad" },
    { label: "Settling", val: m.settled ? m.settle.toFixed(2) + "s" : "—", cls: !m.settled ? "bad" : m.settle < 1 ? "good" : m.settle < 1.8 ? "warn" : "bad" },
    { label: "Steady-state err", val: m.ssError.toFixed(2) + " " + unit, cls: m.ssError < 0.1 ? "good" : m.ssError < 0.5 ? "warn" : "bad" },
  ];
  els.metrics.innerHTML = cards.map((c) => `<div class="metric ${c.cls}"><div class="label">${c.label}</div><div class="num">${c.val}</div></div>`).join("");
}

// ---- code snippet ----
function renderSnippet() {
  const cfg = MODES[state.mode];
  const sensor = state.mode === "drive" ? "drivePositionInches()" : "headingDegrees()";
  const cmd = state.mode === "drive" ? "setDrivePower(power)" : "setTurnPower(power)";
  els.snippet.textContent =
`// ${cfg.label} — tuned in VEX PID Tuner
double kP = ${round(state.kP)}, kI = ${round(state.kI)}, kD = ${round(state.kD)};
double target = ${state.target};            // ${cfg.unit}
double error, integral = 0, derivative, lastError = 0;

while (true) {
  error = target - ${sensor};
  integral += error;
  if (fabs(error) < ${state.mode === "drive" ? "1.0" : "2.0"}) integral = 0;   // anti-windup near target
  derivative = error - lastError;

  double power = kP * error + kI * integral + kD * derivative;
  ${cmd};                              // clamp to [-1, 1] / [-12V, 12V]

  lastError = error;
  wait(10, msec);
}`;
}

// ---- main update ----
function update() {
  const p = { mode: state.mode, kP: state.kP, kI: state.kI, kD: state.kD, target: state.target };
  const displayRun = simulate({ ...p, noise: state.noise, disturbance: state.disturbance });
  const cleanRun = simulate(p); // metrics off the clean response
  draw(displayRun, cleanRun);
  renderMetrics(metrics(cleanRun), MODES[state.mode].unit);
  renderSnippet();
}

// ---- events ----
els.mode.addEventListener("change", () => { state.mode = els.mode.value; applyMode(); });
els.target.addEventListener("input", () => { state.target = Number(els.target.value); els.targetVal.textContent = `${state.target} ${MODES[state.mode].unit}`; update(); });
for (const k of ["kP", "kI", "kD"]) {
  els[k].addEventListener("input", () => { state[k] = Number(els[k].value); els[k + "num"].value = round(state[k]); update(); });
  els[k + "num"].addEventListener("input", () => { state[k] = Number(els[k + "num"].value) || 0; els[k].value = state[k]; update(); });
}
els.noise.addEventListener("change", () => { state.noise = els.noise.checked; update(); });
els.disturb.addEventListener("change", () => { state.disturbance = els.disturb.checked; update(); });

els.autotune.addEventListener("click", () => {
  els.autotune.textContent = "Tuning…";
  setTimeout(() => {
    const best = autoTune(state.mode, state.target);
    Object.assign(state, { kP: best.kP, kI: best.kI, kD: best.kD });
    syncInputs(); update();
    els.autotune.textContent = "⚡ Auto-tune";
    toast(`Auto-tuned: ${best.m.overshoot.toFixed(0)}% overshoot, ${best.m.settle.toFixed(2)}s settle`);
  }, 20);
});
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    const g = preset(b.dataset.preset, state.mode, state.target);
    Object.assign(state, { kP: g.kP, kI: g.kI, kD: g.kD });
    syncInputs(); update();
    if (b.dataset.preset === "zn") toast(g.fallback ? "No clean oscillation found — used auto-tune" : `Ziegler–Nichols: Ku=${round(g.Ku)}, Tu=${g.Tu.toFixed(2)}s`);
  })
);
els.keep.addEventListener("click", () => { keptRun = simulate({ mode: state.mode, kP: state.kP, kI: state.kI, kD: state.kD, target: state.target }); update(); toast("Kept current run for comparison"); });
els.reset.addEventListener("click", () => applyMode());
els.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(els.snippet.textContent); toast("PID code copied to clipboard"); }
  catch { toast("Copy failed — select the code manually"); }
});
window.addEventListener("resize", () => update());

function toast(msg) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

applyMode();
