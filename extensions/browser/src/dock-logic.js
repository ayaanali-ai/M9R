(function (global) {
  "use strict";

  const HALF_PI = Math.PI / 2;
  const TAU = Math.PI * 2;
  const EDGES = ["top", "right", "bottom", "left"];
  // Unit vector pointing into the page from each edge, in the order of EDGES.
  const INWARD = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }];

  function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  /**
   * The dock's track: a rounded rectangle inset from the window edge, walked clockwise from the top edge.
   * `theta` is the direction of travel in degrees: 0 along the top, 90 down the right side, 180 along the bottom, 270 up the left.
   */
  function makePath(vw, vh, margin, radius) {
    const m = Math.max(0, margin);
    const x0 = m;
    const y0 = m;
    const x1 = Math.max(x0 + 1, vw - m);
    const y1 = Math.max(y0 + 1, vh - m);
    const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
    const arcLen = HALF_PI * r;
    const segs = [];
    let at = 0;
    const line = (ax, ay, bx, by, theta) => {
      const len = Math.hypot(bx - ax, by - ay);
      segs.push({ type: "line", start: at, len, ax, ay, bx, by, theta });
      at += len;
    };
    const arc = (cx, cy, phi0, theta0) => {
      segs.push({ type: "arc", start: at, len: arcLen, cx, cy, r, phi0, theta0 });
      at += arcLen;
    };
    line(x0 + r, y0, x1 - r, y0, 0);
    arc(x1 - r, y0 + r, -HALF_PI, 0);
    line(x1, y0 + r, x1, y1 - r, 90);
    arc(x1 - r, y1 - r, 0, 90);
    line(x1 - r, y1, x0 + r, y1, 180);
    arc(x0 + r, y1 - r, HALF_PI, 180);
    line(x0, y1 - r, x0, y0 + r, 270);
    arc(x0 + r, y0 + r, Math.PI, 270);
    return { vw, vh, margin: m, radius: r, length: at, segs };
  }

  /** A path sized so a capsule of `thickness` sits `gap` px off the window edge, turning corners with `radius`. */
  function pathFor(vw, vh, options) {
    const o = options || {};
    const thickness = Number.isFinite(o.thickness) ? o.thickness : 40;
    const gap = Number.isFinite(o.gap) ? o.gap : 12;
    const radius = Number.isFinite(o.radius) ? o.radius : 64;
    return makePath(vw, vh, thickness / 2 + gap, radius);
  }

  function pointAt(path, t) {
    const total = path.length;
    const at = total > 0 ? ((t % total) + total) % total : 0;
    for (let i = 0; i < path.segs.length; i += 1) {
      const s = path.segs[i];
      if (at < s.start + s.len || i === path.segs.length - 1) {
        const u = clamp(at - s.start, 0, s.len);
        if (s.type === "line") {
          const f = s.len > 0 ? u / s.len : 0;
          return { x: s.ax + (s.bx - s.ax) * f, y: s.ay + (s.by - s.ay) * f, theta: s.theta, t: at };
        }
        const phi = s.phi0 + (s.r > 0 ? u / s.r : 0);
        const theta = s.theta0 + (s.len > 0 ? (u / s.len) * 90 : 0);
        return { x: s.cx + s.r * Math.cos(phi), y: s.cy + s.r * Math.sin(phi), theta, t: at };
      }
    }
    return { x: 0, y: 0, theta: 0, t: 0 };
  }

  /** The closest point on the track to a pointer, so a drag anywhere on screen glides along the edges and around corners. */
  function project(path, px, py) {
    let best = null;
    for (const s of path.segs) {
      let qx;
      let qy;
      let t;
      if (s.type === "line") {
        const dx = s.bx - s.ax;
        const dy = s.by - s.ay;
        const len2 = dx * dx + dy * dy;
        const f = len2 > 0 ? clamp(((px - s.ax) * dx + (py - s.ay) * dy) / len2, 0, 1) : 0;
        qx = s.ax + dx * f;
        qy = s.ay + dy * f;
        t = s.start + f * s.len;
      } else if (s.r > 0) {
        const phi = Math.atan2(py - s.cy, px - s.cx);
        let delta = (((phi - s.phi0) % TAU) + TAU) % TAU;
        if (delta > HALF_PI) delta = TAU - delta < delta - HALF_PI ? 0 : HALF_PI;
        qx = s.cx + s.r * Math.cos(s.phi0 + delta);
        qy = s.cy + s.r * Math.sin(s.phi0 + delta);
        t = s.start + delta * s.r;
      } else {
        qx = s.cx;
        qy = s.cy;
        t = s.start;
      }
      const dist = Math.hypot(px - qx, py - qy);
      if (!best || dist < best.dist) best = { t, x: qx, y: qy, dist };
    }
    return best || { t: 0, x: 0, y: 0, dist: 0 };
  }

  /** Which edge the dock is on, whether it lies vertical, and how far it is tilted while turning a corner (-45..45 degrees). */
  function orientationAt(theta) {
    const normalized = ((theta % 360) + 360) % 360;
    const card = Math.round(normalized / 90) % 4;
    let tilt = normalized - card * 90;
    if (tilt > 180) tilt -= 360;
    return { edge: EDGES[card], card, vertical: card % 2 === 1, tilt };
  }

  /** The capsule's box, centred on a point of the track; it turns on its side along the left and right edges. */
  function capsuleBox(point, orientation, long, short) {
    const width = orientation.vertical ? short : long;
    const height = orientation.vertical ? long : short;
    return { left: point.x - width / 2, top: point.y - height / 2, width, height };
  }

  /** Where the opened bar or thread goes: it grows away from the dock's edge and is kept fully inside the window. */
  function placeExpanded(point, card, size, vw, vh, options) {
    const o = options || {};
    const offset = Number.isFinite(o.offset) ? o.offset : 28;
    const pad = Number.isFinite(o.pad) ? o.pad : 8;
    const n = INWARD[((card % 4) + 4) % 4];
    const along = Math.abs(n.x) * size.w + Math.abs(n.y) * size.h;
    const cx = point.x + n.x * (along / 2 + offset);
    const cy = point.y + n.y * (along / 2 + offset);
    const width = Math.min(size.w, Math.max(0, vw - pad * 2));
    const height = Math.min(size.h, Math.max(0, vh - pad * 2));
    return {
      left: clamp(cx - width / 2, pad, Math.max(pad, vw - width - pad)),
      top: clamp(cy - height / 2, pad, Math.max(pad, vh - height - pad)),
      width,
      height,
      edge: EDGES[((card % 4) + 4) % 4],
    };
  }

  const SPRING_PRESETS = {
    snap: { stiffness: 420, damping: 2 * Math.sqrt(420) },
    soft: { stiffness: 190, damping: 2 * Math.sqrt(190) * 0.9 },
    lively: { stiffness: 260, damping: 2 * Math.sqrt(260) * 0.7 },
  };

  /** A damped spring stepped by elapsed time, so motion feels physical and never snaps. */
  function createSpring(options) {
    const o = options || {};
    const stiffness = Number.isFinite(o.stiffness) ? o.stiffness : SPRING_PRESETS.soft.stiffness;
    const damping = Number.isFinite(o.damping) ? o.damping : SPRING_PRESETS.soft.damping;
    const mass = Number.isFinite(o.mass) && o.mass > 0 ? o.mass : 1;
    const precision = Number.isFinite(o.precision) ? o.precision : 0.02;
    let value = Number.isFinite(o.value) ? o.value : 0;
    let velocity = 0;
    let target = value;
    return {
      get value() { return value; },
      get velocity() { return velocity; },
      get target() { return target; },
      setTarget(next) { target = next; },
      jump(next) { value = next; target = next; velocity = 0; },
      settled() { return Math.abs(value - target) < precision && Math.abs(velocity) < precision; },
      step(seconds) {
        const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 0, 0.05);
        if (dt === 0) return value;
        const n = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / n;
        for (let i = 0; i < n; i += 1) {
          const accel = (-stiffness * (value - target) - damping * velocity) / mass;
          velocity += accel * h;
          value += velocity * h;
        }
        if (Math.abs(value - target) < precision && Math.abs(velocity) < precision) {
          value = target;
          velocity = 0;
        }
        return value;
      },
    };
  }

  /** Aim a spring that travels around the track at a new position by the short way round (the track is a loop). */
  function retarget(spring, t, length) {
    if (!(length > 0)) {
      spring.setTarget(t);
      return;
    }
    const current = spring.value;
    const base = ((current % length) + length) % length;
    const delta = ((((t - base) + length / 2) % length) + length) % length - length / 2;
    spring.setTarget(current + delta);
  }

  global.M9RDock = { makePath, pathFor, pointAt, project, orientationAt, capsuleBox, placeExpanded, createSpring, retarget, SPRING_PRESETS, EDGES };
})(typeof window !== "undefined" ? window : globalThis);
