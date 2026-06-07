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
    this.points = []; // {x, y, hx, hy, custom}
    this.snap = false;
    this.curve = false;
    this.trail = null;
    this._drag = null;

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
      if (p.custom) continue;
      const prev = a[i], next = a[i + 2] || a[i + 1]; // anchor i is a[i+1]
      p.hx = (next.x - prev.x) / 6; p.hy = (next.y - prev.y) / 6;
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
    if (d && d.type === "add" && !d.moved) {
      this.points.push({ x: clamp(this._snap(d.x)), y: clamp(this._snap(d.y)), hx: 0, hy: 0, custom: false });
      this.recomputeAutoHandles();
      this.draw(); this.onChange(this.state());
    }
  }
  _dbl(e) {
    const [x, y] = this._evIn(e);
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this._hit(x, y, this.points[i].x, this.points[i].y, 12)) {
        this.points.splice(i, 1); this.recomputeAutoHandles(); this.draw(); this.onChange(this.state()); return;
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
  setCurve(on) { this.curve = on; this.trail = null; if (on) this.recomputeAutoHandles(); this.draw(); }
  clearPoints() { this.stopPath(); this.points = []; this.trail = null; this.draw(); this.onChange(this.state()); }
  resetRobot() { this.stopPath(); this.robot.x = 0; this.robot.y = -48; this.robot.heading = 0; this.trail = null; this.recomputeAutoHandles(); this.draw(); this.onChange(this.state()); }
  state() { return { robot: { ...this.robot }, points: this.points.map((p) => ({ x: p.x, y: p.y })) }; }

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
    const Ld = 20, vCruise = 38, Ksteer = 1.7, maxOmega = 200, dt = 0.02;
    let t = 0, near = 0, done = false;
    const step = () => {
      for (let k = 0; k < 2; k++) {
        while (near < samples.length - 1 && dist(this.robot, samples[near + 1]) < dist(this.robot, samples[near])) near++;
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
        let cte = Infinity;
        for (let j = 0; j < samples.length - 1; j++) { const dd = segDist(this.robot, samples[j], samples[j + 1]); if (dd < cte) cte = dd; }
        this.trail.push({ x: this.robot.x, y: this.robot.y });
        onFrame && onFrame({ t, cte });
        if (remaining < 1.2 || t > 16) { done = true; break; }
      }
      if (done) {
        this._anim = null;
        this.robot.x = start.x; this.robot.y = start.y; this.robot.heading = start.heading;
        this.draw(); this.onChange(this.state()); onDone && onDone();
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

    ctx.fillStyle = "#13131f"; ctx.fillRect(x0, y0, px, px);
    for (let r = 0; r < 6; r++) for (let col = 0; col < 6; col++) {
      ctx.fillStyle = (r + col) % 2 ? "rgba(170,178,255,0.05)" : "rgba(170,178,255,0.02)";
      ctx.fillRect(x0 + (col * px) / 6, y0 + (r * px) / 6, px / 6, px / 6);
    }
    for (let g = -FIELD / 2; g <= FIELD / 2 + 0.1; g += 12) {
      ctx.strokeStyle = Math.abs(g % TILE) < 0.1 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
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
    ctx.strokeStyle = "rgba(200,205,230,0.55)"; ctx.lineWidth = 4; ctx.strokeRect(x0, y0, px, px);

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
function rad(d) { return (d * Math.PI) / 180; }
function deg(r) { return (r * 180) / Math.PI; }
function fmt(n) { return (Math.round(n * 10) / 10).toString(); }
