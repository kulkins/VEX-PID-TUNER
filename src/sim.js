// VEX drivetrain PID simulation — pure functions (no DOM), so the same code
// runs the UI and the headless tests.
//
// Plant model: a motor command u ∈ [-1, 1] drives the robot. Velocity follows
//   dv/dt = u·accelMax − v·(accelMax/vMax)   (first-order: u=1 → v→vMax)
//   dx/dt = v                                (position is the integral)
// which is the classic position-control plant. A static-friction deadband means
// very small efforts can't move the robot, so a P-only loop stops short of the
// target (steady-state error) — exactly why you add kI.

export const DT = 0.01; // 10 ms control loop, like a real VEX program

export const MODES = {
  drive: {
    label: "Drive to distance",
    unit: "in",
    target: 24,
    targetMin: 6,
    targetMax: 72,
    vMax: 62, // in/s at full power
    accelMax: 210, // in/s^2
    deadband: 0.04, // |u| below this can't overcome static friction
    noiseStd: 0.15, // encoder noise (in)
    delaySteps: 3, // sensor/loop delay (≈30 ms) — real loops lag, and it lets high kP oscillate
    duration: 3.0,
    disturb: -28, // a shove backward (in/s)
    kpMax: 0.4,
    kiMax: 0.6,
    kdMax: 0.08,
  },
  turn: {
    label: "Turn to heading",
    unit: "°",
    target: 90,
    targetMin: 15,
    targetMax: 180,
    vMax: 330, // deg/s
    accelMax: 1400, // deg/s^2
    deadband: 0.05,
    noiseStd: 0.6, // gyro noise (deg)
    delaySteps: 2, // ≈20 ms
    duration: 2.2,
    disturb: -150,
    kpMax: 0.12,
    kiMax: 0.2,
    kdMax: 0.03,
  },
};

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Run one closed-loop simulation. Returns time series + setpoint.
export function simulate({ mode = "drive", kP = 0, kI = 0, kD = 0, target, noise = false, disturbance = false } = {}) {
  const cfg = MODES[mode];
  const T = target ?? cfg.target;
  const n = Math.round(cfg.duration / DT);
  const drag = cfg.accelMax / cfg.vMax;
  const rng = mulberry32(0xC0FFEE); // fixed seed → noise looks identical run-to-run
  let x = 0, v = 0, integral = 0, prevMeas = 0;
  const t = [], xs = [], meas = [], us = [], hist = [];
  const distStep = disturbance ? Math.round(n * 0.55) : -1;
  const delay = cfg.delaySteps || 0;

  for (let i = 0; i < n; i++) {
    hist.push(x); // true position at the start of this step
    const sensed = i >= delay ? hist[i - delay] : 0; // controller sees a delayed reading
    const measured = noise ? sensed + gauss(rng) * cfg.noiseStd : sensed;
    const error = T - measured;
    integral += error * DT;
    if (kI > 1e-9) {
      const iMax = 1 / kI; // anti-windup: keep the integral term ≤ full output
      integral = Math.max(-iMax, Math.min(iMax, integral));
    }
    const deriv = -(measured - prevMeas) / DT; // derivative on measurement (no setpoint kick)
    prevMeas = measured;

    let u = kP * error + kI * integral + kD * deriv;
    u = Math.max(-1, Math.min(1, u));
    const applied = Math.abs(u) < cfg.deadband ? 0 : u; // static friction

    const a = applied * cfg.accelMax - v * drag;
    v += a * DT;
    if (i === distStep) v += cfg.disturb; // external shove
    x += v * DT;

    t.push(i * DT);
    xs.push(x);
    meas.push(measured);
    us.push(u);
  }
  return { t, x: xs, measured: meas, u: us, target: T, mode, dt: DT, distAt: distStep >= 0 ? distStep * DT : null, cfg };
}

// Step-response metrics from a (clean) run.
export function metrics(run) {
  const { x, target, t } = run;
  const aT = Math.abs(target) || 1;
  const band = 0.05 * aT; // 5% settling band
  let rise = null, peak = 0, settle = 0;
  for (let i = 0; i < x.length; i++) {
    if (rise === null && Math.abs(x[i]) >= 0.9 * aT) rise = t[i];
    const over = target >= 0 ? x[i] - target : target - x[i];
    if (over > peak) peak = over;
    if (Math.abs(x[i] - target) > band) settle = t[i] + DT;
  }
  const settled = settle < run.cfg.duration * 0.98;
  return {
    rise,
    overshoot: peak > 0 ? (peak / aT) * 100 : 0,
    settle,
    settled,
    ssError: Math.abs(x[x.length - 1] - target),
  };
}

// Cost-based auto-tune: grid-search gains, minimize settling + overshoot + error.
export function autoTune(mode, target) {
  const cfg = MODES[mode];
  const T = target ?? cfg.target;
  const kPs = [], kDs = [];
  for (let i = 0; i < 26; i++) kPs.push((0.2 + (i * (6 - 0.2)) / 25) / T);
  for (let i = 0; i < 16; i++) kDs.push((i * 1.2) / 15 / T);
  const kIs = [0, 0.3 / T, 0.8 / T, 1.6 / T];
  let best = null;
  for (const kP of kPs)
    for (const kD of kDs)
      for (const kI of kIs) {
        const m = metrics(simulate({ mode, kP, kI, kD, target: T }));
        let cost = m.settle + 0.4 * m.overshoot + 12 * m.ssError;
        if (!m.settled) cost += 100;
        if (m.overshoot > 35) cost += m.overshoot - 35;
        if (best === null || cost < best.cost) best = { kP, kI, kD, cost, m };
      }
  return best;
}

function localMaxima(x) {
  const p = [];
  for (let i = 2; i < x.length - 2; i++)
    if (x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > x[i - 2]) p.push(i);
  return p;
}

// Classic Ziegler–Nichols: raise kP (P-only) to the ultimate gain Ku where the
// response sustains oscillation, read the period Tu, then apply ZN gains.
// Falls back to auto-tune if no clean oscillation is found.
export function zieglerNichols(mode, target) {
  const cfg = MODES[mode];
  const T = target ?? cfg.target;
  for (let kP = 0.3 / T; kP <= 25 / T; kP *= 1.12) {
    const run = simulate({ mode, kP, kI: 0, kD: 0, target: T });
    const peaks = localMaxima(run.x);
    if (peaks.length >= 3) {
      const a1 = Math.abs(run.x[peaks[1]] - T);
      const a2 = Math.abs(run.x[peaks[2]] - T);
      if (a1 > 0.02 * T && a2 / a1 > 0.7) {
        const Ku = kP;
        const Tu = run.t[peaks[2]] - run.t[peaks[1]];
        return { kP: 0.6 * Ku, kI: (1.2 * Ku) / Tu, kD: 0.075 * Ku * Tu, Ku, Tu };
      }
    }
  }
  const b = autoTune(mode, target);
  return { kP: b.kP, kI: b.kI, kD: b.kD, fallback: true };
}

// Hand-picked presets per mode (sensible starting points).
export function preset(name, mode, target) {
  const cfg = MODES[mode];
  const T = target ?? cfg.target;
  if (name === "smooth") return { kP: 1.2 / T, kI: 0.2 / T, kD: 1.4 / T };
  if (name === "aggressive") return { kP: 4.0 / T, kI: 0.6 / T, kD: 1.0 / T };
  if (name === "zn") return zieglerNichols(mode, target);
  return { kP: 0, kI: 0, kD: 0 };
}
