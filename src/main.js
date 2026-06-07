import { MODES, simulate, metrics, autoTune, preset, DT } from "./sim.js";
import { Field } from "./field.js";

const $ = (id) => document.getElementById(id);
const els = {
  mode: $("mode"), target: $("target"), targetVal: $("targetVal"),
  kP: $("kP"), kI: $("kI"), kD: $("kD"),
  kPnum: $("kPnum"), kInum: $("kInum"), kDnum: $("kDnum"),
  noise: $("noise"), disturb: $("disturb"),
  autotune: $("autotune"), keep: $("keep"), reset: $("reset"), copy: $("copy"),
  chart: $("chart"), metrics: $("metrics"), snippet: $("snippet"), template: $("template"),
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

// ---- code snippet (multiple template formats) ----
const SNIPPETS = {
  vexcode(s, cfg, k) {
    const sensor = s.mode === "drive" ? "drivePositionInches()" : "headingDegrees()";
    const cmd = s.mode === "drive" ? "setDrivePower(power)" : "setTurnPower(power)";
    return `// ${cfg.label} — VEXcode V5 (C++)
double kP = ${k.kP}, kI = ${k.kI}, kD = ${k.kD};
double target = ${s.target};            // ${cfg.unit}
double error, integral = 0, derivative, lastError = 0;

while (true) {
  error = target - ${sensor};
  integral += error;
  if (fabs(error) < ${s.mode === "drive" ? "1.0" : "2.0"}) integral = 0;   // anti-windup near target
  derivative = error - lastError;

  double power = kP * error + kI * integral + kD * derivative;
  ${cmd};                              // clamp to [-1, 1] / [-12V, 12V]

  lastError = error;
  wait(10, msec);
}`;
  },
  lemlib(s, cfg, k) {
    const drive = s.mode === "drive";
    const name = drive ? "lateral_controller" : "angular_controller";
    const sm = drive ? 1 : 1, lg = drive ? 3 : 3;
    return `// LemLib — ${drive ? "lateral (drive)" : "angular (turn)"} controller settings (PROS)
lemlib::ControllerSettings ${name}(
    ${k.kP},   // kP
    ${k.kI},   // kI
    ${k.kD},   // kD
    3,         // anti-windup range
    ${sm}, 100,    // small error (${cfg.unit}), small-error timeout (ms)
    ${lg}, 500,    // large error (${cfg.unit}), large-error timeout (ms)
    20         // slew rate (max accel)
);`;
  },
  jar(s, cfg, k) {
    const p = s.mode === "drive" ? "drive" : "turn";
    return `// JAR-Template — ${p} PID constants (set in your chassis config)
float ${p}_kp = ${k.kP};
float ${p}_ki = ${k.kI};
float ${p}_kd = ${k.kD};
float ${p}_starti = 0;            // error at which to start integrating
float ${p}_settle_error = ${s.mode === "drive" ? "1.0" : "2.0"};   // ${cfg.unit}
float ${p}_settle_time = 300;     // ms
float ${p}_timeout = 5000;        // ms`;
  },
  rw(s, cfg, k) {
    // RW-Template (richardbwang/RW-Template) — gains live in
    // custom/src/robot-config.cpp as global doubles.
    return s.mode === "drive"
      ? `// RW-Template — linear (drive) PID  ·  custom/src/robot-config.cpp
double distance_kp = ${k.kP}, distance_ki = ${k.kI}, distance_kd = ${k.kD};
// (heading_correction_* keeps the robot straight while driving)`
      : `// RW-Template — turn PID  ·  custom/src/robot-config.cpp
double turn_kp = ${k.kP}, turn_ki = ${k.kI}, turn_kd = ${k.kD};`;
  },
};

function renderSnippet() {
  const cfg = MODES[state.mode];
  const k = { kP: round(state.kP), kI: round(state.kI), kD: round(state.kD) };
  const tpl = (els.template && els.template.value) || "vexcode";
  els.snippet.textContent = (SNIPPETS[tpl] || SNIPPETS.vexcode)(state, cfg, k);
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
els.template.addEventListener("change", renderSnippet);
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

// ===================== Field view =====================
const field = new Field($("field"), renderFieldReadout);
window.__field = field; // exposed for the console / debugging

function renderFieldReadout(s) {
  const r = s.robot;
  const rows = s.points.map((p, i) => `
    <div class="wp-edit" data-i="${i}">
      <span class="wp-num">${i + 1}</span>
      <label>X<input type="number" step="1" data-k="x" value="${round(p.x)}" /></label>
      <label>Y<input type="number" step="1" data-k="y" value="${round(p.y)}" /></label>
      <label>θ<input type="number" step="5" data-k="heading" placeholder="auto" value="${p.heading == null ? "" : Math.round(p.heading)}" /></label>
    </div>`).join("") ||
    `<div class="muted small">No waypoints yet — click the field to add one.</div>`;
  $("fieldReadout").innerHTML =
    `<div class="wp-edit robot-row">
       <span class="wp-num bot">R</span>
       <label>X<input type="number" step="1" data-rk="x" value="${round(r.x)}" /></label>
       <label>Y<input type="number" step="1" data-rk="y" value="${round(r.y)}" /></label>
       <label>θ<input type="number" step="5" data-rk="heading" value="${Math.round(r.heading)}" /></label>
     </div>
     <div class="wps">${rows}</div>`;
  wireReadoutInputs();
}

// Wire the editable coordinate/heading inputs. Inputs fire on "change" (blur /
// Enter) and call field methods that redraw without rebuilding the list, so an
// edit in one field never yanks focus out of the one you're typing in.
function wireReadoutInputs() {
  $("fieldReadout").querySelectorAll(".wp-edit[data-i] input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const i = Number(inp.closest(".wp-edit").dataset.i);
      const k = inp.dataset.k;
      const raw = inp.value.trim();
      field.updatePoint(i, k, k === "heading" && raw === "" ? null : Number(raw));
    });
  });
  $("fieldReadout").querySelectorAll(".robot-row input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const k = inp.dataset.rk;
      field.setRobotPose({ [k]: Number(inp.value) });
      if (k === "heading") {
        $("heading").value = Math.round(field.robot.heading);
        $("headingVal").textContent = Math.round(field.robot.heading) + "°";
      }
    });
  });
}

// tabs
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    const v = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("tunerView").hidden = v !== "tuner";
    $("fieldView").hidden = v !== "field";
    if (v === "field") field.resize(); // canvas needs a real size once visible
    else update();
  })
);

// field controls
$("robotW").addEventListener("input", () => field.setRobotSize(Number($("robotW").value) || 18, field.robot.l));
$("robotL").addEventListener("input", () => field.setRobotSize(field.robot.w, Number($("robotL").value) || 18));
$("heading").addEventListener("input", () => { field.setHeading(Number($("heading").value)); $("headingVal").textContent = $("heading").value + "°"; });
$("snap").addEventListener("change", () => field.setSnap($("snap").checked));
$("curve").addEventListener("change", () => field.setCurve($("curve").checked));
$("showField").addEventListener("change", () => field.setShowField($("showField").checked));

// Run the path: animate the robot following it + plot cross-track error.
let trackData = [];
$("runPath").addEventListener("click", () => {
  if (field.running) { field.stopPath(); $("runPath").textContent = "▶ Run path"; return; }
  trackData = [];
  $("runPath").textContent = "■ Stop";
  field.runPath(
    (f) => { trackData.push(f); drawTrack(); },
    () => {
      $("runPath").textContent = "▶ Run path";
      const maxC = trackData.reduce((m, d) => Math.max(m, d.cte), 0);
      $("trackVal").textContent = trackData.length ? `peak ${maxC.toFixed(1)} in · final ${trackData[trackData.length - 1].cte.toFixed(1)} in` : "";
    }
  );
});

function drawTrack() {
  const c = $("trackChart"), ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const mL = 34, mB = 16, mT = 6, mR = 8, pw = W - mL - mR, ph = H - mT - mB;
  const tMax = Math.max(2, trackData.length ? trackData[trackData.length - 1].t : 2);
  const cMax = Math.max(2, ...trackData.map((d) => d.cte));
  ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.fillStyle = "#9b9cc6"; ctx.font = "10px system-ui";
  for (let g = 0; g <= 2; g++) { const v = (g / 2) * cMax, y = mT + ph - (v / cMax) * ph; ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(W - mR, y); ctx.stroke(); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(v.toFixed(1), mL - 5, y); }
  ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText("in", 4, mT + 10);
  ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(tMax.toFixed(1) + "s", W - mR, H);
  ctx.strokeStyle = "#6effb1"; ctx.lineWidth = 2; ctx.beginPath();
  trackData.forEach((d, i) => { const x = mL + (d.t / tMax) * pw, y = mT + ph - (Math.min(d.cte, cMax) / cMax) * ph; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();
}
$("clearPath").addEventListener("click", () => field.clearPoints());
$("resetRobot").addEventListener("click", () => { field.resetRobot(); $("heading").value = 0; $("headingVal").textContent = "0°"; });
$("copyPath").addEventListener("click", async () => {
  const s = field.state();
  const lines = s.points.map((p) => `  { ${p.x}, ${p.y} },`).join("\n");
  const code = `// Autonomous waypoints (x, y) in inches — field-centre origin\n` +
    `// Robot start: (${round(s.robot.x)}, ${round(s.robot.y)}) @ ${Math.round(s.robot.heading)}°\n` +
    `double path[][2] = {\n${lines}\n};`;
  try { await navigator.clipboard.writeText(code); toast(`Copied ${s.points.length} waypoint(s)`); }
  catch { toast("Copy failed"); }
});

// keep the field's heading slider in sync when the robot is rotated by dragging
const origRender = renderFieldReadout;
field.onChange = (s) => { origRender(s); $("heading").value = Math.round(s.robot.heading); $("headingVal").textContent = Math.round(s.robot.heading) + "°"; };
