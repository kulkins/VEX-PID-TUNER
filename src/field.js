// Top-down VEX V5 field path planner. Coordinate system: origin (0,0) at field
// centre, +x right, +y up (forward), inches. Heading = clockwise from +y.
//
// Curved paths use cubic Béziers through each waypoint with draggable tangent
// handles (jerry.io style). Each waypoint stores a handle offset (hx, hy); the
// outgoing control point is anchor+h and the incoming is anchor−h (smooth/G1).
// Handles auto-compute from neighbours until you drag one (then it's "custom").

const FIELD = 144;
const TILE = 24;

export class Field {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.robot = { x: 0, y: -48, heading: 0, w: 18, l: 18 };
    this.points = []; // {x, y, hx, hy, custom, heading}  (heading: null = auto/unconstrained)
    this.snap = false;
    this.curve = false;
    this.trail = null;
    this._drag = null;

    // ---- auto-tuners ----
    // Curve: handle length factor; auto-smooth re-derives every handle from its
    // neighbours in real time (overriding manual drags) for a continuous path.
    this.smoothFactor = 1 / 6;
    this.autoSmooth = true;
    // Follower: pure-pursuit params, grid-searched against the path so it tracks
    // tightly and actually reaches the end (re-tunes live as the path changes).
    this.followDefault = { Ld: 20, vCruise: 38, Ksteer: 1.7 };
    this.follow = { ...this.followDefault };
    this.autoFollow = true;
    this._tune = null;       // { best cost } from the last search
    this._lastPeak = null;   // peak cross-track error of the last run (in)
    this._lastWobble = null; // weave count of the last run
    this._lastMiss = null;   // worst waypoint miss of the last run (in)

    // Optional real game-field background (drop a field.png in the project).
    this.showField = true;
    this.bgReady = false;
    this.bgImg = new Image();
    this.bgImg.onload = () => { this.bgReady = true; this.draw(); };
    this.bgImg.onerror = () => { this.bgReady = false; };
    this.bgImg.src = "./field.png";

    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    window.addEventListener("pointerup", () => this._up());
    canvas.addEventListener("dblclick", (e) => this._dbl(e));
    window.addEventListener("resize", () => this.resize());
  }

  // ---- coordinate mapping ----
  resize() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pad = 18;
    this.span = Math.min(c.clientWidth, c.clientHeight) - this.pad * 2;
    this.ox = c.clientWidth / 2; this.oy = c.clientHeight / 2;
    this.scale = this.span / FIELD;
    this.draw();
  }
  toPx(x, y) { return [this.ox + x * this.scale, this.oy - y * this.scale]; }
  toIn(px, py) { return [(px - this.ox) / this.scale, (this.oy - py) / this.scale]; }
  _evIn(e) { const r = this.canvas.getBoundingClientRect(); return this.toIn(e.clientX - r.left, e.clientY - r.top); }
  _snap(v) { return this.snap ? Math.round(v / 6) * 6 : Math.round(v * 10) / 10; }
  _hit(x, y, tx, ty, px = 10) { return Math.hypot(x - tx, y - ty) * this.scale < px; }

  // ---- Bézier path ----
  recomputeAutoHandles() {
    const a = [{ x: this.robot.x, y: this.robot.y }, ...this.points];
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (!this.autoSmooth && p.custom) continue; // manual mode keeps dragged handles
      const prev = a[i], next = a[i + 2] || a[i + 1]; // anchor i is a[i+1]
      p.hx = (next.x - prev.x) * this.smoothFactor; p.hy = (next.y - prev.y) * this.smoothFactor;
    }
  }
  _anchors() {
    const a = [{ x: this.robot.x, y: this.robot.y, h: null }];
    for (const p of this.points) a.push({ x: p.x, y: p.y, h: { x: p.hx, y: p.hy } });
    if (a.length > 1) a[0].h = { x: (a[1].x - a[0].x) / 3, y: (a[1].y - a[0].y) / 3 };
    return a;
  }
  // Sampled polyline of the path (curve → Bézier, else straight).
  sampledPath(seg = 26) {
    const a = this._anchors();
    if (a.length < 2) return a.map((p) => ({ x: p.x, y: p.y }));
    if (!this.curve) return a.map((p) => ({ x: p.x, y: p.y }));
    const out = [];
    for (let i = 0; i < a.length - 1; i++) {
      const P0 = a[i], P3 = a[i + 1];
      const P1 = { x: P0.x + a[i].h.x, y: P0.y + a[i].h.y };
      const P2 = { x: P3.x - a[i + 1].h.x, y: P3.y - a[i + 1].h.y };
      for (let j = 0; j < seg; j++) out.push(cubicAt(P0, P1, P2, P3, j / seg));
    }
    out.push({ x: a[a.length - 1].x, y: a[a.length - 1].y });
    return out;
  }

  // ---- interaction ----
  _down(e) {
    this.stopPath(); this.trail = null;
    const [x, y] = this._evIn(e);
    // robot rotate handle (nose)
    const nose = this._nose();
    if (this._hit(x, y, nose[0], nose[1], 12)) { this._drag = { type: "rotate", moved: false }; return; }
    // bézier handles (only when curved)
    if (this.curve) {
      for (let i = this.points.length - 1; i >= 0; i--) {
        const p = this.points[i];
        if (this._hit(x, y, p.x + p.hx, p.y + p.hy, 9)) { this._drag = { type: "handle", i, side: 1, moved: false }; return; }
        if (this._hit(x, y, p.x - p.hx, p.y - p.hy, 9)) { this._drag = { type: "handle", i, side: -1, moved: false }; return; }
      }
    }
    // waypoints
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      if (this._hit(x, y, p.x, p.y, 10)) { this._drag = { type: "point", i, offX: p.x - x, offY: p.y - y, moved: false }; return; }
    }
    // robot body
    if (this._inRobot(x, y)) { this._drag = { type: "robot", offX: this.robot.x - x, offY: this.robot.y - y, moved: false }; return; }
    this._drag = { type: "add", x, y, moved: false };
  }
  _move(e) {
    if (!this._drag) return;
    const [x, y] = this._evIn(e);
    const d = this._drag; d.moved = true;
    if (d.type === "robot") {
      this.robot.x = clamp(this._snap(x + d.offX)); this.robot.y = clamp(this._snap(y + d.offY));
      this.recomputeAutoHandles();
    } else if (d.type === "point") {
      const p = this.points[d.i]; p.x = clamp(this._snap(x + d.offX)); p.y = clamp(this._snap(y + d.offY));
      this.recomputeAutoHandles();
    } else if (d.type === "handle") {
      const p = this.points[d.i];
      if (d.side > 0) { p.hx = x - p.x; p.hy = y - p.y; } else { p.hx = p.x - x; p.hy = p.y - y; }
      p.custom = true;
    } else if (d.type === "rotate") {
      this.robot.heading = (deg(Math.atan2(x - this.robot.x, y - this.robot.y)) + 360) % 360;
    } else return;
    this.draw(); this.onChange(this.state());
  }
  _up() {
    const d = this._drag; this._drag = null;
    if (!d) return;
    if (d.type === "add" && !d.moved) {
      this.points.push({ x: clamp(this._snap(d.x)), y: clamp(this._snap(d.y)), hx: 0, hy: 0, custom: false, heading: null });
      this.recomputeAutoHandles();
    }
    this.maybeAutoTune(); // re-tune the follower to the edited path, live
    this.draw(); this.onChange(this.state());
  }
  _dbl(e) {
    const [x, y] = this._evIn(e);
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this._hit(x, y, this.points[i].x, this.points[i].y, 12)) {
        this.points.splice(i, 1); this.recomputeAutoHandles(); this.maybeAutoTune(); this.draw(); this.onChange(this.state()); return;
      }
    }
  }
  _nose() { const r = this.robot, t = rad(r.heading); return [r.x + Math.sin(t) * (r.l / 2 + 7), r.y + Math.cos(t) * (r.l / 2 + 7)]; }
  _inRobot(x, y) {
    const r = this.robot, t = -rad(r.heading), dx = x - r.x, dy = y - r.y;
    const lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
    return Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.l / 2;
  }

  // ---- public API ----
  setRobotSize(w, l) { this.robot.w = w; this.robot.l = l; this.draw(); this.onChange(this.state()); }
  setHeading(d) { this.robot.heading = ((d % 360) + 360) % 360; this.draw(); this.onChange(this.state()); }
  setSnap(on) { this.snap = on; }
  setShowField(on) { this.showField = on; this.draw(); }
  setCurve(on) { this.curve = on; this.trail = null; if (on) this.recomputeAutoHandles(); this.maybeAutoTune(); this.draw(); }
  setSmoothFactor(f) { this.smoothFactor = f; if (this.autoSmooth) this.recomputeAutoHandles(); this.draw(); }
  setAutoSmooth(on) { this.autoSmooth = on; if (on) this.recomputeAutoHandles(); this.draw(); }
  // Reset both auto-tuners to defaults: re-enable live smoothing, clear manual
  // handle drags, and restore the follower gains + tuning history.
  resetTuner() {
    this.autoSmooth = true; this.smoothFactor = 1 / 6;
    this.points.forEach((p) => { p.custom = false; });
    this.follow = { ...this.followDefault }; this._tune = null; this._lastPeak = null; this._lastWobble = null; this._lastMiss = null;
    this.recomputeAutoHandles(); this.draw(); this.onChange(this.state());
  }
  // Headless follower rollout — same pure-pursuit math as runPath but no drawing,
  // so the tuner can score thousands of candidate gains instantly. Returns the
  // peak cross-track error, weave count, how far short of the end it stopped, and
  // the worst waypoint miss (closest the robot got to each waypoint).
  _rollout(Ld, Ksteer, vCruise) {
    if (!this.points.length) return { peak: 0, wobble: 0, endErr: 0, miss: 0 };
    const samples = this.curve ? this.sampledPath(26) : densify([{ x: this.robot.x, y: this.robot.y }, ...this.points], 10);
    const arc = [0];
    for (let i = 1; i < samples.length; i++) arc[i] = arc[i - 1] + dist(samples[i - 1], samples[i]);
    const total = arc[arc.length - 1];
    const rb = { x: this.robot.x, y: this.robot.y, heading: this.robot.heading };
    const pts = this.points, miss = pts.map(() => Infinity);
    const maxOmega = 200, dt = 0.02;
    let t = 0, near = 0, peak = 0, wobble = 0, lastSide = 0, remaining = total;
    while (t < 16) {
      let bestD = Infinity, bestI = near;
      const hiN = Math.min(samples.length, near + 30);
      for (let j = near; j < hiN; j++) { const d = dist(rb, samples[j]); if (d < bestD) { bestD = d; bestI = j; } }
      near = bestI; remaining = total - arc[near];
      let li = near; while (li < samples.length - 1 && arc[li] - arc[near] < Ld) li++;
      const tgt = samples[li];
      const he = ((deg(Math.atan2(tgt.x - rb.x, tgt.y - rb.y)) - rb.heading + 540) % 360) - 180;
      rb.heading = (rb.heading + Math.max(-maxOmega, Math.min(maxOmega, Ksteer * he)) * dt + 360) % 360;
      let v = vCruise * Math.max(0, 1 - Math.abs(he) / 55);
      if (remaining < 22) v *= Math.max(0.04, remaining / 22);
      rb.x += Math.sin(rad(rb.heading)) * v * dt; rb.y += Math.cos(rad(rb.heading)) * v * dt;
      t += dt;
      for (let k = 0; k < pts.length; k++) { const d = dist(rb, pts[k]); if (d < miss[k]) miss[k] = d; }
      let cte = Infinity, jB = near;
      const lo = Math.max(0, near - 3), hi = Math.min(samples.length - 1, li + 3);
      for (let j = lo; j < hi; j++) { const dd = segDist(rb, samples[j], samples[j + 1]); if (dd < cte) { cte = dd; jB = j; } }
      if (cte > peak) peak = cte;
      const a0 = samples[jB], b0 = samples[jB + 1];
      const side = Math.sign((b0.x - a0.x) * (rb.y - a0.y) - (b0.y - a0.y) * (rb.x - a0.x));
      if (cte > 0.3 && side !== 0) { if (lastSide && side !== lastSide) wobble++; lastSide = side; }
      if (remaining < 1.5) break;
    }
    return { peak, wobble, endErr: Math.max(0, total - arc[near] - 1.5), miss: Math.max(0, ...miss) };
  }
  // Grid-search lookahead × steering for the lowest cost. Cost order: reach the
  // end → hit every waypoint → don't weave → low cross-track error. Hitting the
  // points is weighted heavily because a small lookahead is what cuts corners.
  autoTuneFollower() {
    if (!this.points.length) return null;
    const vC = this.followDefault.vCruise;
    let best = null;
    for (let Ld = 4; Ld <= 36.001; Ld += 4) {
      for (let Ks = 0.8; Ks <= 3.0001; Ks += 0.3) {
        const m = this._rollout(Ld, Ks, vC);
        const cost = 3 * m.endErr + 1.3 * m.miss + 0.4 * m.wobble + 0.3 * m.peak;
        if (!best || cost < best.cost) best = { Ld, Ksteer: Ks, cost, m };
      }
    }
    if (best) {
      this.follow = { Ld: best.Ld, vCruise: vC, Ksteer: best.Ksteer };
      this._tune = { best: best.cost };
    }
    return best;
  }
  maybeAutoTune() { if (this.autoFollow) this.autoTuneFollower(); }
  clearPoints() { this.stopPath(); this.points = []; this.trail = null; this.draw(); this.onChange(this.state()); }
  resetRobot() { this.stopPath(); this.robot.x = 0; this.robot.y = -48; this.robot.heading = 0; this.trail = null; this.recomputeAutoHandles(); this.draw(); this.onChange(this.state()); }
  state() { return { robot: { ...this.robot }, points: this.points.map((p) => ({ x: p.x, y: p.y, heading: p.heading })) }; }

  // Edit a single waypoint's coordinate or heading from the readout inputs.
  // Does NOT fire onChange so the inputs aren't rebuilt while you're typing.
  updatePoint(i, key, val) {
    const p = this.points[i]; if (!p) return;
    if (key === "heading") {
      p.heading = (val == null || val === "" || Number.isNaN(val)) ? null : (((val % 360) + 360) % 360);
    } else if (key === "x" || key === "y") {
      if (Number.isNaN(val)) return;
      p[key] = clamp(val); this.recomputeAutoHandles(); this.maybeAutoTune();
    }
    this.draw();
  }
  // Edit the robot's start pose from the readout inputs (same no-rebuild contract).
  setRobotPose({ x, y, heading } = {}) {
    if (x != null && !Number.isNaN(x)) this.robot.x = clamp(x);
    if (y != null && !Number.isNaN(y)) this.robot.y = clamp(y);
    if (heading != null && !Number.isNaN(heading)) this.robot.heading = ((heading % 360) + 360) % 360;
    this.recomputeAutoHandles(); this.maybeAutoTune(); this.draw();
  }

  // ---- run path (pure-pursuit follower) ----
  runPath(onFrame, onDone) {
    this.stopPath();
    if (!this.points.length) { onDone && onDone(); return; }
    const start = { x: this.robot.x, y: this.robot.y, heading: this.robot.heading };
    const samples = this.curve ? this.sampledPath(26) : densify([{ x: start.x, y: start.y }, ...this.points], 10);
    const arc = [0];
    for (let i = 1; i < samples.length; i++) arc[i] = arc[i - 1] + dist(samples[i - 1], samples[i]);
    const total = arc[arc.length - 1];

    this.trail = [{ x: start.x, y: start.y }];
    const { Ld, vCruise, Ksteer } = this.follow; const maxOmega = 200, dt = 0.02;
    const miss = this.points.map(() => Infinity);
    let t = 0, near = 0, done = false, peak = 0, wobble = 0, lastSide = 0;
    const step = () => {
      for (let k = 0; k < 2; k++) {
        // advance to the closest sample within a LOCAL window ahead — monotonic,
        // and (unlike a global search) it won't teleport across a path that
        // loops back over itself, which would skip waypoints.
        let bestD = Infinity, bestI = near;
        const hiN = Math.min(samples.length, near + 30);
        for (let j = near; j < hiN; j++) { const d = dist(this.robot, samples[j]); if (d < bestD) { bestD = d; bestI = j; } }
        near = bestI;
        const remaining = total - arc[near];
        let li = near; while (li < samples.length - 1 && arc[li] - arc[near] < Ld) li++;
        const tgt = samples[li];
        const desired = deg(Math.atan2(tgt.x - this.robot.x, tgt.y - this.robot.y));
        const he = ((desired - this.robot.heading + 540) % 360) - 180;
        const omega = Math.max(-maxOmega, Math.min(maxOmega, Ksteer * he));
        this.robot.heading = (this.robot.heading + omega * dt + 360) % 360;
        let v = vCruise * Math.max(0, 1 - Math.abs(he) / 55);
        if (remaining < 22) v *= Math.max(0.04, remaining / 22);
        this.robot.x += Math.sin(rad(this.robot.heading)) * v * dt;
        this.robot.y += Math.cos(rad(this.robot.heading)) * v * dt;
        t += dt;
        let cte = Infinity, jBest = 0;
        for (let j = 0; j < samples.length - 1; j++) { const dd = segDist(this.robot, samples[j], samples[j + 1]); if (dd < cte) { cte = dd; jBest = j; } }
        if (cte > peak) peak = cte;
        // signed side of the path → count weaves (sign flips) as oscillation
        const a0 = samples[jBest], b0 = samples[jBest + 1];
        const side = Math.sign((b0.x - a0.x) * (this.robot.y - a0.y) - (b0.y - a0.y) * (this.robot.x - a0.x));
        if (cte > 0.3 && side !== 0) { if (lastSide && side !== lastSide) wobble++; lastSide = side; }
        for (let m = 0; m < this.points.length; m++) { const d = dist(this.robot, this.points[m]); if (d < miss[m]) miss[m] = d; }
        this.trail.push({ x: this.robot.x, y: this.robot.y });
        onFrame && onFrame({ t, cte, dist: arc[near], total }); // dist travelled vs target distance
        if (remaining < 1.5 || t > 16) { done = true; break; } // arc-based: robust on looping paths
      }
      if (done) {
        this._anim = null;
        this.robot.x = start.x; this.robot.y = start.y; this.robot.heading = start.heading;
        this._lastPeak = peak; this._lastWobble = wobble; this._lastMiss = Math.max(0, ...miss);
        this.draw(); this.onChange(this.state()); onDone && onDone(peak);
      } else { this.draw(); this._anim = requestAnimationFrame(step); }
    };
    this._anim = requestAnimationFrame(step);
  }
  stopPath() { if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; } }
  get running() { return !!this._anim; }

  // ---- rendering ----
  draw() {
    const ctx = this.ctx, c = this.canvas;
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    const [x0, y0] = this.toPx(-FIELD / 2, FIELD / 2);
    const px = this.span;

    const useImg = this.showField && this.bgReady;
    if (useImg) {
      ctx.drawImage(this.bgImg, x0, y0, px, px); // real game field
    } else {
      ctx.fillStyle = "#13131f"; ctx.fillRect(x0, y0, px, px);
      for (let r = 0; r < 6; r++) for (let col = 0; col < 6; col++) {
        ctx.fillStyle = (r + col) % 2 ? "rgba(170,178,255,0.05)" : "rgba(170,178,255,0.02)";
        ctx.fillRect(x0 + (col * px) / 6, y0 + (r * px) / 6, px / 6, px / 6);
      }
    }
    // coordinate grid (fainter over the field photo so it stays readable)
    for (let g = -FIELD / 2; g <= FIELD / 2 + 0.1; g += 12) {
      const tile = Math.abs(g % TILE) < 0.1;
      ctx.strokeStyle = useImg
        ? (tile ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)")
        : (tile ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)");
      ctx.lineWidth = 1;
      let p = this.toPx(g, FIELD / 2); ctx.beginPath(); ctx.moveTo(p[0], p[1]); p = this.toPx(g, -FIELD / 2); ctx.lineTo(p[0], p[1]); ctx.stroke();
      p = this.toPx(-FIELD / 2, g); ctx.beginPath(); ctx.moveTo(p[0], p[1]); p = this.toPx(FIELD / 2, g); ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(170,178,255,0.5)"; ctx.lineWidth = 1.5;
    let a = this.toPx(-FIELD / 2, 0), b = this.toPx(FIELD / 2, 0); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    a = this.toPx(0, -FIELD / 2); b = this.toPx(0, FIELD / 2); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.fillStyle = "#9b9cc6"; ctx.font = "10px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let g = -72; g <= 72; g += 24) { if (g) { const p = this.toPx(g, 0); ctx.fillText(g, p[0], p[1] + 3); } }
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let g = -72; g <= 72; g += 24) { if (g) { const p = this.toPx(0, g); ctx.fillText(g, p[0] + 3, p[1]); } }
    if (!useImg) { ctx.strokeStyle = "rgba(200,205,230,0.55)"; ctx.lineWidth = 4; ctx.strokeRect(x0, y0, px, px); }

    // path
    if (this.points.length) {
      const pts = this.sampledPath(this.curve ? 26 : 1);
      ctx.strokeStyle = "rgba(110,255,177,0.9)"; ctx.lineWidth = 2.4; if (!this.curve) ctx.setLineDash([6, 4]);
      ctx.beginPath(); pts.forEach((p, i) => { const q = this.toPx(p.x, p.y); i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1]); }); ctx.stroke(); ctx.setLineDash([]);

      // bézier handles
      if (this.curve) {
        this.points.forEach((p) => {
          const ha = this.toPx(p.x + p.hx, p.y + p.hy), hb = this.toPx(p.x - p.hx, p.y - p.hy);
          ctx.strokeStyle = "rgba(170,178,255,0.7)"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(ha[0], ha[1]); ctx.lineTo(hb[0], hb[1]); ctx.stroke();
          for (const h of [ha, hb]) { ctx.fillStyle = "#aab2ff"; ctx.beginPath(); ctx.arc(h[0], h[1], 4.5, 0, 7); ctx.fill(); }
        });
      }
      // waypoint dots + labels
      this.points.forEach((p, i) => {
        const q = this.toPx(p.x, p.y);
        // per-waypoint heading arrow (only when a heading is set)
        if (p.heading != null) {
          const t = rad(p.heading);
          const e = this.toPx(p.x + Math.sin(t) * 13, p.y + Math.cos(t) * 13);
          const ang = Math.atan2(e[1] - q[1], e[0] - q[0]);
          ctx.strokeStyle = "#ffd76e"; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
          ctx.fillStyle = "#ffd76e"; ctx.beginPath();
          ctx.moveTo(e[0], e[1]);
          ctx.lineTo(e[0] - 7 * Math.cos(ang - 0.45), e[1] - 7 * Math.sin(ang - 0.45));
          ctx.lineTo(e[0] - 7 * Math.cos(ang + 0.45), e[1] - 7 * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = "#6effb1"; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, 7); ctx.fill();
        ctx.fillStyle = "#07120c"; ctx.font = "bold 9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(i + 1, q[0], q[1]);
        ctx.fillStyle = "#cdd3e6"; ctx.font = "10px system-ui"; ctx.textBaseline = "bottom"; ctx.fillText(`(${fmt(p.x)}, ${fmt(p.y)})`, q[0], q[1] - 8);
      });
    }

    // driven trail
    if (this.trail && this.trail.length > 1) {
      ctx.strokeStyle = "#aab2ff"; ctx.lineWidth = 2.5; ctx.beginPath();
      this.trail.forEach((p, i) => { const q = this.toPx(p.x, p.y); i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1]); }); ctx.stroke();
    }

    // robot
    const r = this.robot, t = rad(r.heading), [cx, cy] = this.toPx(r.x, r.y);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t);
    const w = r.w * this.scale, l = r.l * this.scale;
    ctx.fillStyle = "rgba(170,178,255,0.22)"; ctx.strokeStyle = "#aab2ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(-w / 2, -l / 2, w, l); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#aab2ff"; ctx.beginPath(); ctx.moveTo(0, -l / 2 - 9); ctx.lineTo(-6, -l / 2); ctx.lineTo(6, -l / 2); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function cubicAt(P0, P1, P2, P3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * P0.x + b * P1.x + c * P2.x + d * P3.x, y: a * P0.y + b * P1.y + c * P2.y + d * P3.y };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function densify(pts, per = 8) {
  if (pts.length < 2) return pts.slice();
  const out = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) for (let j = 1; j <= per; j++) { const t = j / per; out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }); }
  return out;
}
function clamp(v) { return Math.max(-FIELD / 2, Math.min(FIELD / 2, v)); }
function clampRange(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rad(d) { return (d * Math.PI) / 180; }
function deg(r) { return (r * 180) / Math.PI; }
function fmt(n) { return (Math.round(n * 10) / 10).toString(); }
