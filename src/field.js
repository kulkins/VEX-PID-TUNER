// Top-down VEX V5 field path planner. Coordinate system: origin (0,0) at field
// centre, +x right, +y up (forward), inches. Heading is measured clockwise from
// +y (0° = facing "up"/away), like a VEX inertial sensor.

const FIELD = 144; // 12 ft, in inches
const TILE = 24; // foam tiles

export class Field {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onChange = onChange || (() => {});
    this.robot = { x: 0, y: -48, heading: 0, w: 18, l: 18 };
    this.points = [];
    this.snap = false;
    this._drag = null; // {type:'robot'|'rotate'|'point', i, offX, offY, moved}

    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    window.addEventListener("pointerup", () => this._up());
    canvas.addEventListener("dblclick", (e) => this._dbl(e));
    window.addEventListener("resize", () => this.resize());
  }

  // ---- coordinate mapping ----
  resize() {
    const c = this.canvas;
    const size = Math.min(c.clientWidth, c.clientHeight) || c.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pad = 18;
    this.span = Math.min(c.clientWidth, c.clientHeight) - this.pad * 2;
    this.ox = c.clientWidth / 2;
    this.oy = c.clientHeight / 2;
    this.scale = this.span / FIELD; // px per inch
    this.draw();
  }
  toPx(x, y) { return [this.ox + x * this.scale, this.oy - y * this.scale]; }
  toIn(px, py) { return [(px - this.ox) / this.scale, (this.oy - py) / this.scale]; }
  _evIn(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.toIn(e.clientX - r.left, e.clientY - r.top);
  }
  _snap(v) { return this.snap ? Math.round(v / 6) * 6 : Math.round(v * 10) / 10; }

  // ---- interaction ----
  _down(e) {
    const [x, y] = this._evIn(e);
    // rotate handle (nose)?
    const nose = this._nose();
    if (Math.hypot(x - nose[0], y - nose[1]) * this.scale < 12) {
      this._drag = { type: "rotate", moved: false };
      return;
    }
    // a waypoint?
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      if (Math.hypot(x - p.x, y - p.y) * this.scale < 10) {
        this._drag = { type: "point", i, offX: p.x - x, offY: p.y - y, moved: false };
        return;
      }
    }
    // robot body?
    if (this._inRobot(x, y)) {
      this._drag = { type: "robot", offX: this.robot.x - x, offY: this.robot.y - y, moved: false };
      return;
    }
    // empty → remember for a potential "add point" on pointerup
    this._drag = { type: "add", x, y, moved: false };
  }
  _move(e) {
    if (!this._drag) return;
    const [x, y] = this._evIn(e);
    const d = this._drag;
    d.moved = true;
    if (d.type === "robot") {
      this.robot.x = clamp(this._snap(x + d.offX));
      this.robot.y = clamp(this._snap(y + d.offY));
    } else if (d.type === "point") {
      this.points[d.i] = { x: clamp(this._snap(x + d.offX)), y: clamp(this._snap(y + d.offY)) };
    } else if (d.type === "rotate") {
      const dx = x - this.robot.x, dy = y - this.robot.y;
      this.robot.heading = (deg(Math.atan2(dx, dy)) + 360) % 360;
    } else return;
    this.draw();
    this.onChange(this.state());
  }
  _up() {
    const d = this._drag;
    this._drag = null;
    if (d && d.type === "add" && !d.moved) {
      this.points.push({ x: clamp(this._snap(d.x)), y: clamp(this._snap(d.y)) });
      this.draw();
      this.onChange(this.state());
    }
  }
  _dbl(e) {
    const [x, y] = this._evIn(e);
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (Math.hypot(x - this.points[i].x, y - this.points[i].y) * this.scale < 12) {
        this.points.splice(i, 1);
        this.draw();
        this.onChange(this.state());
        return;
      }
    }
  }
  _nose() {
    const r = this.robot, t = rad(r.heading);
    return [r.x + Math.sin(t) * (r.l / 2 + 7), r.y + Math.cos(t) * (r.l / 2 + 7)];
  }
  _inRobot(x, y) {
    const r = this.robot, t = -rad(r.heading);
    const dx = x - r.x, dy = y - r.y;
    // rotate point into robot frame
    const lx = dx * Math.cos(t) - dy * Math.sin(t);
    const ly = dx * Math.sin(t) + dy * Math.cos(t);
    return Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.l / 2;
  }

  // ---- public API ----
  setRobotSize(w, l) { this.robot.w = w; this.robot.l = l; this.draw(); this.onChange(this.state()); }
  setHeading(deg) { this.robot.heading = ((deg % 360) + 360) % 360; this.draw(); this.onChange(this.state()); }
  setSnap(on) { this.snap = on; }
  clearPoints() { this.points = []; this.draw(); this.onChange(this.state()); }
  resetRobot() { this.robot.x = 0; this.robot.y = -48; this.robot.heading = 0; this.draw(); this.onChange(this.state()); }
  state() { return { robot: { ...this.robot }, points: this.points.map((p) => ({ ...p })) }; }

  // ---- rendering ----
  draw() {
    const ctx = this.ctx, c = this.canvas;
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    const [x0, y0] = this.toPx(-FIELD / 2, FIELD / 2);
    const px = this.span;

    // field background + foam tiles
    ctx.fillStyle = "#13131f";
    ctx.fillRect(x0, y0, px, px);
    for (let r = 0; r < 6; r++)
      for (let col = 0; col < 6; col++) {
        ctx.fillStyle = (r + col) % 2 ? "rgba(170,178,255,0.05)" : "rgba(170,178,255,0.02)";
        ctx.fillRect(x0 + (col * px) / 6, y0 + (r * px) / 6, px / 6, px / 6);
      }
    // grid lines: 12" faint, 24" (tiles) stronger
    for (let g = -FIELD / 2; g <= FIELD / 2 + 0.1; g += 12) {
      const strong = Math.abs(g % TILE) < 0.1;
      ctx.strokeStyle = strong ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      let p = this.toPx(g, FIELD / 2); ctx.beginPath(); ctx.moveTo(p[0], p[1]); p = this.toPx(g, -FIELD / 2); ctx.lineTo(p[0], p[1]); ctx.stroke();
      p = this.toPx(-FIELD / 2, g); ctx.beginPath(); ctx.moveTo(p[0], p[1]); p = this.toPx(FIELD / 2, g); ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    // axes through origin
    ctx.strokeStyle = "rgba(170,178,255,0.5)"; ctx.lineWidth = 1.5;
    let a = this.toPx(-FIELD / 2, 0), b = this.toPx(FIELD / 2, 0);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    a = this.toPx(0, -FIELD / 2); b = this.toPx(0, FIELD / 2);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    // axis ticks (every 24")
    ctx.fillStyle = "#9b9cc6"; ctx.font = "10px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let g = -72; g <= 72; g += 24) { if (g === 0) continue; const p = this.toPx(g, 0); ctx.fillText(g, p[0], p[1] + 3); }
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let g = -72; g <= 72; g += 24) { if (g === 0) continue; const p = this.toPx(0, g); ctx.fillText(g, p[0] + 3, p[1]); }
    // perimeter wall
    ctx.strokeStyle = "rgba(200,205,230,0.55)"; ctx.lineWidth = 4; ctx.strokeRect(x0, y0, px, px);

    // path (polyline through robot start + waypoints)
    if (this.points.length) {
      ctx.strokeStyle = "rgba(110,255,177,0.85)"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      let p0 = this.toPx(this.robot.x, this.robot.y); ctx.moveTo(p0[0], p0[1]);
      for (const p of this.points) { const q = this.toPx(p.x, p.y); ctx.lineTo(q[0], q[1]); }
      ctx.stroke(); ctx.setLineDash([]);
      this.points.forEach((p, i) => {
        const q = this.toPx(p.x, p.y);
        ctx.fillStyle = "#6effb1"; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, 7); ctx.fill();
        ctx.fillStyle = "#07120c"; ctx.font = "bold 9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(i + 1, q[0], q[1]);
        ctx.fillStyle = "#cdd3e6"; ctx.font = "10px system-ui"; ctx.textBaseline = "bottom";
        ctx.fillText(`(${fmt(p.x)}, ${fmt(p.y)})`, q[0], q[1] - 8);
      });
    }

    // robot
    const r = this.robot, t = rad(r.heading), [cx, cy] = this.toPx(r.x, r.y);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t); // canvas y is down; heading from +y cw → rotate by t works with sin/cos below
    const w = r.w * this.scale, l = r.l * this.scale;
    ctx.fillStyle = "rgba(170,178,255,0.22)"; ctx.strokeStyle = "#aab2ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(-w / 2, -l / 2, w, l); ctx.fill(); ctx.stroke();
    // heading arrow (toward +y in robot frame → up on screen before rotate; but our rotate maps +y-forward)
    ctx.fillStyle = "#aab2ff"; ctx.beginPath();
    ctx.moveTo(0, -l / 2 - 9); ctx.lineTo(-6, -l / 2); ctx.lineTo(6, -l / 2); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function clamp(v) { return Math.max(-FIELD / 2, Math.min(FIELD / 2, v)); }
function rad(d) { return (d * Math.PI) / 180; }
function deg(r) { return (r * 180) / Math.PI; }
function fmt(n) { return (Math.round(n * 10) / 10).toString(); }
