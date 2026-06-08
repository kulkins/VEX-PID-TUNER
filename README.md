# VEX PID Tuner + Field Planner

Four tools in one browser app, no robot required:

1. **PID Tuner** — tune a drivetrain controller and watch the closed-loop
   response in real time.
2. **Field Planner** — a top-down VEX V5 field (over a photo of the real game
   field) with a coordinate grid, a draggable/rotatable robot outline, and
   clickable waypoints (straight or smooth curved paths). **Run path** drives the
   robot along the route with a pure-pursuit follower and plots live
   **cross-track error**. Exports paste-ready autonomous code for **LemLib** and
   **EZ-Template** (with or without odometry).
3. **Replay** — paste real error-over-time logged off your actual robot and tune
   against ground truth (no sim physics in the loop). Reads back rise/overshoot/
   settling/steady-state and suggests gain changes.
4. **Learn** — an interactive walkthrough of what P, I, and D each do to the
   response curve, one term at a time.

The tuner exports gains in your template's format: **VEXcode V5**, **LemLib**,
**JAR-Template**, or RW-Template.

**▶ Live demo:** _deploy to GitHub Pages / Netlify (see below)_

![VEX PID Tuner](docs/screenshot.png)

## What it does

- **Two mechanisms:** *drive to distance* and *turn to heading* (position control
  with realistic momentum, a static-friction deadband, and ~20–30 ms loop delay).
- **Live response chart** — setpoint, response, the 5% settling band, and a
  disturbance marker — redrawn instantly as you drag the **kP / kI / kD** sliders.
- **Tuning metrics:** rise time, overshoot %, settling time, steady-state error,
  color-coded so you can see what "good" looks like.
- **Sensor noise + disturbances** — inject encoder/gyro noise and a mid-run shove
  to see how kI and kD react.
- **Auto-tune** — a cost-based grid search that minimizes settling time +
  overshoot + steady-state error.
- **Presets** — Smooth, Aggressive, and a real **Ziegler–Nichols** tune (finds the
  ultimate gain Kᵤ and period Tᵤ from a sustained-oscillation search).
- **Copy code** — exports your gains as a drop-in VEXcode V5 C++ PID loop.

## How the model works

A motor command `u ∈ [-1, 1]` drives a first-order velocity plant
(`dv/dt = u·aMax − v·aMax/vMax`, so `u = 1 → v → vMax`) whose integral is position.
A static-friction deadband means tiny efforts can't move the robot — so a P-only
loop stops short of the target (steady-state error), which is exactly why you add
kI. A small sensor/loop **delay** makes high kP oscillate, just like a real robot,
and makes the Ziegler–Nichols method meaningful. Derivative is taken on the
measurement (no setpoint kick), with integral anti-windup.

It's a teaching model — simplified, but it reproduces the behaviors you actually
tune against on a VEX robot.

## Project layout

```
index.html     Page shell (Tuner / Field tabs)
style.css      Theme + layout
src/sim.js     Physics + PID + metrics + auto-tune + Ziegler–Nichols (pure, testable)
src/field.js   Top-down field: coordinate grid, robot outline, waypoint path
src/main.js    UI wiring, Canvas chart, presets, code export, tab switching
```

## Field Planner

A 12'×12' field (24" foam tiles) with a centre-origin coordinate grid (inches),
over a photo of the real game field. Click to drop waypoints, drag the robot or
any point to move it, drag the robot's nose to rotate, double-click a point to
delete, or type an exact **X / Y / heading (θ)** for the robot start and each
waypoint. Snap-to-grid (6") optional.

**Odometry toggle.** *Copy waypoints* exports the autonomous in the form your
robot can actually run:

- **Odometry on** — the robot tracks its absolute `(x, y, θ)` pose, so the export
  is `setPose(...)` + `moveToPoint / moveToPose` calls to field coordinates
  (LemLib / JAR / PID-to-point style).
- **Odometry off** — open-loop *dead reckoning*: a relative **turn-then-drive**
  sequence computed from the waypoint geometry, for robots with no tracking
  wheels / position tracking.

Pick **LemLib**, **EZ-Template**, or generic pseudo-code as the export format.
Because the path geometry is exact regardless of the sim, this output is
trustworthy — it's the JerryIO-style "draw a path, paste it into your auto" flow.

**Auto-tuner.** Two things tune themselves:

- **Curve smoothing** — each waypoint's Bézier handles are re-derived from its
  neighbours in real time for a continuous path; a slider sets how round, and
  turning off *auto-smooth* lets you drag handles by hand instead.
- **Follower** — *auto-tune follower* (on by default) grid-searches the
  pure-pursuit lookahead and steering gain against the current path (re-tuning
  live as you edit) for gains that **reach the end, hit every waypoint, and don't
  weave** — it specifically penalizes corner-cutting, since a big lookahead skips
  points. **Run path** then plots **distance travelled vs target distance** (did
  it reach the spot?) alongside cross-track error (did it weave?), and the readout
  shows the worst waypoint miss.

**↺ Reset auto-tuner** restores both to defaults.

## Replay (tune from real telemetry)

Flip the model: instead of trusting the sim, log **error over time** off your
actual robot and paste it in (`t,error` or `t,setpoint,response`, one row per
loop). The app plots it, reads the same step-response metrics off the real curve,
and suggests gain changes (e.g. "oscillating → reduce kP / add kD",
"steady-state error → add kI"). No sim in the loop, so the sim-to-real gap
disappears — you're tuning against ground truth.

## Learn (what P, I, and D each do)

An interactive lesson: the same move, adding one term at a time.

- **P** alone is fast but overshoots and rings.
- **+ D** brakes before the target and kills the overshoot.
- **+ I** (shown against a constant load, like holding an arm up) closes the
  steady-state gap P and D leave behind.

Each step shows the live response curve, the previous step faded for comparison,
and the resulting metrics.

## Run locally

Pure static site, no build step:

```bash
npm run serve      # python3 -m http.server 8010
# open http://localhost:8010
```

## Deploy

Static — host anywhere. For GitHub Pages: push to a repo, then
**Settings → Pages → Deploy from a branch → main / root**.

## How accurate is it?

It's **qualitatively** accurate, not quantitatively. The tuner is a first-order
velocity plant with a friction deadband and loop delay — it reproduces the
*behaviours* you tune against (rise/overshoot/settling, why kI removes
steady-state error, why too much kP oscillates, what a Ziegler–Nichols tune looks
like), so the **shapes and trade-offs transfer** to a real robot. The exact gain
numbers do **not** transfer 1:1: a real drivetrain has mass/inertia, motor
torque-speed curves, gear ratio, battery sag, wheel slip, and per-side dynamics
this model doesn't know about. The field planner's follower is **kinematic**
(geometry only — no slip or accumulated odom drift), so a path that's perfect
here can still drift on a real robot, especially with odometry off. Use both to
build intuition and a *starting* tune, then verify and fine-tune on the robot.
