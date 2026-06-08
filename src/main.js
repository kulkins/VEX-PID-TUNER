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
function metricCardsHTML(m, unit) {
  const cards = [
    { label: "Rise time", val: m.rise == null ? "—" : m.rise.toFixed(2) + "s", cls: m.rise == null ? "bad" : m.rise < 0.6 ? "good" : m.rise < 1.2 ? "warn" : "bad" },
    { label: "Overshoot", val: m.overshoot.toFixed(0) + "%", cls: m.overshoot < 5 ? "good" : m.overshoot < 20 ? "warn" : "bad" },
    { label: "Settling", val: m.settled ? m.settle.toFixed(2) + "s" : "—", cls: !m.settled ? "bad" : m.settle < 1 ? "good" : m.settle < 1.8 ? "warn" : "bad" },
    { label: "Steady-state err", val: m.ssError.toFixed(2) + " " + unit, cls: m.ssError < 0.1 ? "good" : m.ssError < 0.5 ? "warn" : "bad" },
  ];
  return cards.map((c) => `<div class="metric ${c.cls}"><div class="label">${c.label}</div><div class="num">${c.val}</div></div>`).join("");
}
function renderMetrics(m, unit) { els.metrics.innerHTML = metricCardsHTML(m, unit); }

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
window.addEventListener("resize", () => {
  if (!$("replayView").hidden) drawReplay();
  else if (!$("learnView").hidden) drawLearn();
  else if (!$("fieldView").hidden) field.resize();
  else update();
});

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
    $("replayView").hidden = v !== "replay";
    $("learnView").hidden = v !== "learn";
    if (v === "field") field.resize();        // canvas needs a real size once visible
    else if (v === "replay") drawReplay();
    else if (v === "learn") drawLearn();
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

// ---- field auto-tuners (curve smoothing + follower) ----
$("smooth").addEventListener("input", () => {
  const f = Number($("smooth").value);
  $("smoothVal").textContent = f.toFixed(2);
  if (!$("curve").checked) { $("curve").checked = true; field.setCurve(true); } // smoothness only shows on a curve
  field.setSmoothFactor(f);
});
$("autoSmooth").addEventListener("change", () => field.setAutoSmooth($("autoSmooth").checked));
$("autoFollow").addEventListener("change", () => { field.autoTuneFollower = $("autoFollow").checked; renderFollowReadout(); });
$("resetTuner").addEventListener("click", () => {
  field.resetTuner();
  $("smooth").value = "0.17"; $("smoothVal").textContent = "0.17";
  $("autoSmooth").checked = true;
  renderFollowReadout();
  toast("Auto-tuner reset to default");
});
function renderFollowReadout() {
  const f = field.follow, peak = field._lastPeak;
  const best = field._tune && field._tune.best !== Infinity ? field._tune.best : null;
  $("followReadout").innerHTML =
    `Follower: lookahead <b>${f.Ld.toFixed(0)}"</b> · steer <b>${f.Ksteer.toFixed(2)}</b>` +
    (peak != null ? `<br>last run peak CTE ${peak.toFixed(1)}"${best != null ? ` · best ${best.toFixed(1)}"` : ""}` : "") +
    (field.autoTuneFollower ? `<br><span style="color:var(--ok)">learning from each run…</span>` : "");
}

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
      renderFollowReadout();
      if (field.autoTuneFollower) toast(`Auto-tuned follower → Ld ${field.follow.Ld.toFixed(0)}", steer ${field.follow.Ksteer.toFixed(2)}`);
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
// Build the exported autonomous in the chosen team template. WITH odometry the
// robot knows its absolute (x, y, θ) pose, so we emit coordinate moves. WITHOUT
// odometry it's dead reckoning — a relative turn-then-drive sequence the robot
// runs open-loop, computed straight from the path geometry. Path geometry is
// ground truth regardless of the sim, so this output is trustworthy.
function deadReckon(s) {
  // → ordered list of {i, x, y, turn (deg, +CW), drive (in), faceDeg, settle, settleTo}
  let cx = s.robot.x, cy = s.robot.y, ch = s.robot.heading;
  return s.points.map((p, idx) => {
    const dx = p.x - cx, dy = p.y - cy, drive = Math.hypot(dx, dy);
    const face = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    const turn = ((face - ch + 540) % 360) - 180;
    cx = p.x; cy = p.y; ch = face;
    let settle = null, settleTo = null;
    if (p.heading != null) {
      const s2 = ((p.heading - ch + 540) % 360) - 180;
      if (Math.abs(s2) > 0.5) { settle = s2; settleTo = Math.round(p.heading); ch = p.heading; }
    }
    return { i: idx + 1, x: round(p.x), y: round(p.y), turn, drive, faceDeg: Math.round(face), settle, settleTo };
  });
}

function buildPathCode(s, odom, tpl) {
  const sx = round(s.robot.x), sy = round(s.robot.y), sh = Math.round(s.robot.heading);
  if (!s.points.length) return "// No waypoints yet — click the field to add some.";

  if (odom) {
    if (tpl === "lemlib") {
      const body = s.points.map((p) =>
        p.heading == null
          ? `chassis.moveToPoint(${round(p.x)}, ${round(p.y)}, 2000);`
          : `chassis.moveToPose(${round(p.x)}, ${round(p.y)}, ${Math.round(p.heading)}, 2000);`
      ).join("\n");
      return `// LemLib — odometry path · field coords (in), +y forward · origin = field centre\n` +
        `chassis.setPose(${sx}, ${sy}, ${sh});\n${body}`;
    }
    if (tpl === "ez") {
      const body = s.points.map((p) => {
        const pose = p.heading == null ? `${round(p.x)}, ${round(p.y)}` : `${round(p.x)}, ${round(p.y)}, ${Math.round(p.heading)}`;
        return `chassis.pid_odom_set({{${pose}}, fwd, DRIVE_SPEED});\nchassis.pid_wait();`;
      }).join("\n");
      return `// EZ-Template — odometry path · field coords (in)\n` +
        `chassis.odom_pose_set({${sx}, ${sy}, ${sh}});\n${body}`;
    }
    const body = s.points.map((p) =>
      p.heading == null ? `moveToPoint(${round(p.x)}, ${round(p.y)});` : `moveToPose(${round(p.x)}, ${round(p.y)}, ${Math.round(p.heading)});`
    ).join("\n");
    return `// Generic odometry path · field coords (in), +y forward\nsetPose(${sx}, ${sy}, ${sh});\n${body}`;
  }

  // ---- no odometry: dead reckoning ----
  const seq = deadReckon(s);
  if (tpl === "ez") {
    const body = seq.map((m) => {
      const l = [`// → waypoint ${m.i}  (${m.x}, ${m.y})`];
      if (Math.abs(m.turn) > 0.5) l.push(`chassis.pid_turn_set(${m.turn.toFixed(1)}, TURN_SPEED);`, `chassis.pid_wait();`);
      l.push(`chassis.pid_drive_set(${m.drive.toFixed(1)}, DRIVE_SPEED);`, `chassis.pid_wait();`);
      if (m.settle != null) l.push(`chassis.pid_turn_set(${m.settle.toFixed(1)}, TURN_SPEED);  // settle to ${m.settleTo}°`, `chassis.pid_wait();`);
      return l.join("\n");
    }).join("\n");
    return `// EZ-Template — NO ODOMETRY · relative drive/turn (encoder + IMU)\n` +
      `// from start pose (${sx}, ${sy}) @ ${sh}° · pid_turn_set(+) = clockwise\n${body}`;
  }
  const body = seq.map((m) => {
    const l = [`// → waypoint ${m.i}  (${m.x}, ${m.y})`];
    if (Math.abs(m.turn) > 0.5) l.push(`turnFor(${m.turn.toFixed(1)});      // face ${m.faceDeg}°`);
    l.push(`driveFor(${m.drive.toFixed(1)});`);
    if (m.settle != null) l.push(`turnFor(${m.settle.toFixed(1)});      // settle to ${m.settleTo}°`);
    return l.join("\n");
  }).join("\n");
  const note = tpl === "lemlib"
    ? `// LemLib coordinate motions REQUIRE odometry — turn on "Odometry" above for moveToPoint/Pose.\n// Open-loop fallback (wire turnFor/driveFor to your own PID):\n`
    : `// turnFor(+) = clockwise (deg) · driveFor = inches\n`;
  return `// NO ODOMETRY — open-loop dead reckoning from start pose (${sx}, ${sy}) @ ${sh}°\n${note}${body}`;
}

$("copyPath").addEventListener("click", async () => {
  const s = field.state();
  const odom = $("odom").checked;
  const tpl = $("pathTemplate").value;
  const code = buildPathCode(s, odom, tpl);
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${s.points.length} waypoint(s) · ${tpl} · ${odom ? "odom" : "dead-reckoning"}`);
  } catch { toast("Copy failed"); }
});

// keep the field's heading slider in sync when the robot is rotated by dragging
const origRender = renderFieldReadout;
field.onChange = (s) => { origRender(s); $("heading").value = Math.round(s.robot.heading); $("headingVal").textContent = Math.round(s.robot.heading) + "°"; };
renderFollowReadout();

// ===================== Replay view (tune from real telemetry) =====================
// No sim in the loop here — the team's own logged error is ground truth. We just
// visualize it and read the same metrics off it that the tuner uses.
let replayData = null;

function parseTelemetry(text) {
  const t = [], err = [];
  let cols = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    const n = line.split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.length < 2 || n.some(Number.isNaN)) continue; // skip headers / blanks
    cols = Math.max(cols, n.length);
    t.push(n[0]);
    err.push(n.length >= 3 ? n[1] - n[2] : n[1]); // t,setpoint,response → error, else t,error
  }
  return t.length >= 2 ? { t, err, cols } : null;
}

function replayMetrics(t, err) {
  const E0 = Math.abs(err[0]) || 1, band = 0.05 * E0, s0 = Math.sign(err[0]) || 1;
  let rise = null, settle = 0, overshoot = 0, crossings = 0;
  for (let i = 0; i < err.length; i++) {
    if (rise === null && Math.abs(err[i]) <= 0.1 * E0) rise = t[i] - t[0];
    const past = -s0 * err[i]; if (past > overshoot) overshoot = past;
    if (Math.abs(err[i]) > band) settle = t[i] - t[0];
    if (i > 0 && err[i] !== 0 && Math.sign(err[i]) !== Math.sign(err[i - 1])) crossings++;
  }
  const dur = t[t.length - 1] - t[0];
  return { rise, overshoot: (overshoot / E0) * 100, settle, settled: settle < dur * 0.98, ssError: Math.abs(err[err.length - 1]), crossings, E0, dur };
}

function replaySuggest(m) {
  const tips = [];
  if (m.crossings >= 4) tips.push(["Oscillating", "Error keeps flipping sign around zero — reduce kP and/or add kD."]);
  else if (m.overshoot > 25) tips.push(["High overshoot", `~${m.overshoot.toFixed(0)}% past target — lower kP or raise kD.`]);
  if (m.ssError > 0.05 * m.E0 && m.crossings < 4) tips.push(["Steady-state error", "Settles short of target — add/increase kI (watch windup)."]);
  if (!m.settled) tips.push(["Never settles", "Doesn't stay within 5% — too little kP, or too much kI causing drift."]);
  else if (m.overshoot < 5 && m.crossings < 2 && m.settle > 0.6 * m.dur) tips.push(["Sluggish", "Clean but slow — increase kP for a faster rise."]);
  if (!tips.length) tips.push(["Looks well-tuned", "Fast rise, low overshoot, settles near zero. 👌"]);
  return tips;
}

function drawReplay() {
  const c = $("replayChart"), ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const mL = 46, mR = 12, mT = 14, mB = 28, pw = W - mL - mR, ph = H - mT - mB;
  if (!replayData) {
    ctx.fillStyle = "#9b9cc6"; ctx.font = "13px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Paste telemetry and press “Plot & analyze”.", W / 2, H / 2);
    return;
  }
  const { t, err } = replayData;
  const t0 = t[0], tMax = t[t.length - 1] - t0 || 1;
  let yMax = 0, yMin = 0; for (const e of err) { if (e > yMax) yMax = e; if (e < yMin) yMin = e; }
  const pad = (yMax - yMin) * 0.12 + 0.5; yMax += pad; yMin -= pad;
  const X = (s) => mL + ((s - t0) / tMax) * pw, Y = (v) => mT + ph - ((v - yMin) / (yMax - yMin)) * ph;
  // grid + y labels
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9b9cc6"; ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const v = yMin + (g / 4) * (yMax - yMin), y = Y(v); ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(W - mR, y); ctx.stroke(); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(v.toFixed(1), mL - 6, y); }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("error", mL + 2, mT);
  ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(tMax.toFixed(1) + "s", W - mR, H);
  // 5% band + zero line
  const E0 = Math.abs(err[0]) || 1, band = 0.05 * E0;
  ctx.fillStyle = "rgba(110,255,177,0.10)"; ctx.fillRect(mL, Y(band), pw, Y(-band) - Y(band));
  ctx.strokeStyle = "rgba(170,178,255,0.8)"; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(mL, Y(0)); ctx.lineTo(W - mR, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  // error trace
  ctx.strokeStyle = "#6effb1"; ctx.lineWidth = 2.2; ctx.beginPath();
  for (let i = 0; i < t.length; i++) { const x = X(t[i]), y = Y(err[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
}

function analyzeReplay() {
  const parsed = parseTelemetry($("telemetryInput").value);
  if (!parsed) { toast("Couldn't parse — need rows of t,error (or t,setpoint,response)"); return; }
  replayData = parsed;
  drawReplay();
  const m = replayMetrics(parsed.t, parsed.err);
  $("replayMetrics").innerHTML = `<div class="metrics mini-metrics">${metricCardsHTML(
    { rise: m.rise, overshoot: m.overshoot, settle: m.settle, settled: m.settled, ssError: m.ssError }, "")}</div>`;
  $("replaySuggest").innerHTML = `<div class="suggest-head">Suggestions</div>` +
    replaySuggest(m).map(([h, b]) => `<div class="suggest"><b>${h}</b> — ${b}</div>`).join("");
  toast(`Parsed ${parsed.t.length} samples${parsed.cols >= 3 ? " (setpoint/response)" : ""}`);
}

function sampleTelemetry() {
  const run = simulate({ mode: "drive", kP: 5.5 / 24, kI: 0.15 / 24, kD: 0.5 / 24, target: 24 });
  const lines = ["t,error"];
  for (let i = 0; i < run.t.length; i += 2) {
    const e = 24 - run.x[i] + Math.sin(i * 1.7) * 0.06; // a touch of sensor-like noise
    lines.push(`${run.t[i].toFixed(2)}, ${e.toFixed(2)}`);
  }
  return lines.join("\n");
}

$("replayLoad").addEventListener("click", analyzeReplay);
$("replaySample").addEventListener("click", () => { $("telemetryInput").value = sampleTelemetry(); analyzeReplay(); });
$("replayClear").addEventListener("click", () => { $("telemetryInput").value = ""; replayData = null; $("replayMetrics").innerHTML = ""; $("replaySuggest").innerHTML = ""; drawReplay(); });

// ===================== Learn view (what each term does) =====================
const LESSONS = {
  p: { gains: { kP: 5 / 24, kI: 0, kD: 0 }, load: 0, ref: null,
    title: "P — Proportional",
    body: "Output is proportional to error — the farther from target, the harder it drives. Strong P is fast but overshoots and rings before it settles. P gives you speed, not a clean stop." },
  pd: { gains: { kP: 5 / 24, kI: 0, kD: 1.6 / 24 }, load: 0,
    ref: { kP: 5 / 24, kI: 0, kD: 0, load: 0 }, refLabel: "P only",
    title: "D — Derivative",
    body: "D reacts to how fast the error is shrinking and eases off early, braking before the target. The overshoot P caused is gone and it settles sooner. Too much D with a noisy sensor gets jittery." },
  pid: { gains: { kP: 5 / 24, kI: 0.7 / 24, kD: 1.6 / 24 }, load: 110,
    ref: { kP: 5 / 24, kI: 0, kD: 1.6 / 24, load: 110 }, refLabel: "P + D, no I",
    title: "I — Integral",
    body: "Now there's a constant load — think holding an arm up against gravity. P+D stops short: it needs a standing error to make the effort that fights the load. I sums that leftover error over time until the gap closes and it reaches the target. Too much I causes wind-up overshoot." },
};
let lesson = "p";

function drawLearn() {
  const L = LESSONS[lesson], g = L.gains;
  const run = simulate({ mode: "drive", target: 24, ...g, load: L.load, duration: 5 });
  const ref = L.ref ? simulate({ mode: "drive", target: 24, ...L.ref, duration: 5 }) : null;
  // chart
  const c = $("learnChart"), ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const T = 24, mL = 46, mR = 12, mT = 12, mB = 28, pw = W - mL - mR, ph = H - mT - mB;
  let yMax = T; for (const v of run.x) if (v > yMax) yMax = v; yMax = yMax * 1.12 + 2;
  const tMax = run.duration;
  const X = (t) => mL + (t / tMax) * pw, Y = (v) => mT + ph - (v / yMax) * ph;
  ctx.font = "11px system-ui"; ctx.fillStyle = "#9b9cc6"; ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
  for (let gg = 0; gg <= 5; gg++) { const v = (gg / 5) * yMax, y = Y(v); ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(W - mR, y); ctx.stroke(); ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(v.toFixed(0), mL - 6, y); }
  for (let s = 0; s <= tMax + 1e-6; s += 0.5) { const x = X(s); ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(s.toFixed(1) + "s", x, mT + ph + 6); }
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("in", mL + 2, mT);
  // band + setpoint
  ctx.fillStyle = "rgba(170,178,255,0.10)"; ctx.fillRect(mL, Y(T * 1.05), pw, Y(T * 0.95) - Y(T * 1.05));
  ctx.strokeStyle = "rgba(170,178,255,0.85)"; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(mL, Y(T)); ctx.lineTo(W - mR, Y(T)); ctx.stroke(); ctx.setLineDash([]);
  // faded P-only reference
  if (ref) { ctx.strokeStyle = "rgba(155,156,198,0.5)"; ctx.lineWidth = 1.6; ctx.beginPath(); for (let i = 0; i < ref.t.length; i++) { const x = X(ref.t[i]), y = Y(ref.x[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke(); }
  // response
  ctx.strokeStyle = "#aab2ff"; ctx.lineWidth = 2.6; ctx.beginPath();
  for (let i = 0; i < run.t.length; i++) { const x = X(run.t[i]), y = Y(run.x[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
  // text
  document.querySelectorAll(".lesson-btn").forEach((b) => b.classList.toggle("active", b.dataset.lesson === lesson));
  $("lessonCard").innerHTML = `<h4>${L.title}</h4><p>${L.body}</p>`;
  $("learnMetrics").innerHTML = `<div class="metrics mini-metrics">${metricCardsHTML(metrics(run), "in")}</div>`;
  $("learnGains").innerHTML = `kP=${round(g.kP)} · kI=${round(g.kI)} · kD=${round(g.kD)}` +
    (L.load ? ` · load on` : ``) + (ref ? `  &nbsp;·&nbsp; <span style="color:#9b9cc6">faded line = ${L.refLabel}</span>` : "");
}

document.querySelectorAll(".lesson-btn").forEach((b) =>
  b.addEventListener("click", () => { lesson = b.dataset.lesson; drawLearn(); })
);
