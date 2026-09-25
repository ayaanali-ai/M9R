import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../extensions/browser/src/dock-logic.js", import.meta.url), "utf8");

type Point = { x: number; y: number; theta: number; t: number };
type Path = { length: number; radius: number };
type Spring = { value: number; velocity: number; target: number; setTarget(v: number): void; jump(v: number): void; settled(): boolean; step(s: number): number };

function dock() {
  const window: Record<string, unknown> = {};
  runInNewContext(source, { window, Math, Number });
  return window.M9RDock as {
    makePath(vw: number, vh: number, margin: number, radius: number): Path;
    pathFor(vw: number, vh: number, o?: { thickness?: number; gap?: number; radius?: number }): Path;
    pointAt(path: Path, t: number): Point;
    project(path: Path, x: number, y: number): { t: number; x: number; y: number; dist: number };
    orientationAt(theta: number): { edge: string; card: number; vertical: boolean; tilt: number };
    capsuleBox(p: { x: number; y: number }, o: { vertical: boolean }, long: number, short: number): { left: number; top: number; width: number; height: number };
    placeExpanded(p: { x: number; y: number }, card: number, size: { w: number; h: number }, vw: number, vh: number, o?: { offset?: number; pad?: number }): { left: number; top: number; width: number; height: number; edge: string };
    createSpring(o?: { stiffness?: number; damping?: number; value?: number }): Spring;
    retarget(s: Spring, t: number, length: number): void;
  };
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test("the track length is the straight runs plus four quarter circles", () => {
  const d = dock();
  const path = d.makePath(1000, 600, 20, 60);
  near(path.length, 2 * (960 - 120) + 2 * (560 - 120) + 2 * Math.PI * 60, 1e-6);
});

test("the track starts at the top edge, turns the first corner tilted 45 degrees at its middle, and reaches the right edge going down", () => {
  const d = dock();
  const path = d.makePath(1000, 600, 20, 60);
  const start = d.pointAt(path, 0);
  near(start.x, 80); near(start.y, 20); near(start.theta, 0);
  const top = 960 - 120;
  const mid = d.pointAt(path, top + (Math.PI * 60) / 4);
  near(mid.theta, 45, 1e-6);
  near(Math.hypot(mid.x - 920, mid.y - 80), 60, 1e-6);
  const right = d.pointAt(path, top + (Math.PI * 60) / 2);
  near(right.x, 980); near(right.y, 80); near(right.theta, 90);
});

test("walking the track never jumps, including across every corner", () => {
  const d = dock();
  const path = d.makePath(1200, 700, 26, 64);
  const steps = 4000;
  const stride = path.length / steps;
  let previous = d.pointAt(path, 0);
  for (let i = 1; i <= steps; i += 1) {
    const point = d.pointAt(path, i * stride);
    assert.ok(Math.hypot(point.x - previous.x, point.y - previous.y) <= stride * 1.02, `jump at step ${i}`);
    previous = point;
  }
  const wrapped = d.pointAt(path, path.length);
  near(wrapped.x, d.pointAt(path, 0).x, 1e-6);
  near(wrapped.y, d.pointAt(path, 0).y, 1e-6);
});

test("projecting a point that is on the track gives back its position on the track", () => {
  const d = dock();
  const path = d.makePath(1200, 700, 26, 64);
  for (let i = 0; i < 400; i += 1) {
    const t = (path.length * i) / 400;
    const p = d.pointAt(path, t);
    const back = d.project(path, p.x, p.y);
    near(back.dist, 0, 1e-6);
    near(Math.min(Math.abs(back.t - t), path.length - Math.abs(back.t - t)), 0, 1e-4);
  }
});

test("a pointer well inside or outside the window still lands on the nearest part of the track", () => {
  const d = dock();
  const path = d.makePath(1000, 600, 20, 60);
  const inside = d.project(path, 500, 300);
  assert.ok(inside.dist > 100);
  const nearTop = d.project(path, 500, 40);
  near(nearTop.y, 20); near(nearTop.x, 500);
  const outsideCorner = d.project(path, 1200, -50);
  const p = d.pointAt(path, outsideCorner.t);
  assert.ok(p.x > 900 && p.y < 100, "the top-right corner arc is the nearest place");
  const pointerLeft = d.project(path, 3, 300);
  near(pointerLeft.x, 20); near(pointerLeft.y, 300);
});

test("dragging up the left edge and across the top follows the corner instead of jumping", () => {
  const d = dock();
  const path = d.makePath(1000, 600, 20, 60);
  const ts: number[] = [];
  for (const [x, y] of [[8, 400], [8, 200], [8, 90], [20, 40], [50, 16], [120, 8], [400, 8]]) ts.push(d.project(path, x, y).t);
  const unwrapped = ts.map((t) => (t < path.length / 2 ? t + path.length : t));
  for (let i = 1; i < unwrapped.length; i += 1) assert.ok(unwrapped[i] > unwrapped[i - 1], "keeps moving forward around the loop");
});

test("orientation names the edge, turns the capsule on its side, and reports the corner tilt", () => {
  const d = dock();
  assert.deepEqual(JSON.parse(JSON.stringify(d.orientationAt(0))), { edge: "top", card: 0, vertical: false, tilt: 0 });
  assert.equal(d.orientationAt(90).edge, "right");
  assert.equal(d.orientationAt(90).vertical, true);
  assert.equal(d.orientationAt(180).edge, "bottom");
  assert.equal(d.orientationAt(270).edge, "left");
  near(d.orientationAt(20).tilt, 20);
  near(d.orientationAt(350).tilt, -10);
  assert.equal(d.orientationAt(359).edge, "top");
});

test("the capsule is wide on the top and bottom and tall on the sides, centred on its point", () => {
  const d = dock();
  const h = d.capsuleBox({ x: 300, y: 32 }, { vertical: false }, 140, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(h)), { left: 230, top: 12, width: 140, height: 40 });
  const v = d.capsuleBox({ x: 32, y: 300 }, { vertical: true }, 140, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), { left: 12, top: 230, width: 40, height: 140 });
});

test("the opened panel grows away from its edge and stays inside the window", () => {
  const d = dock();
  const top = d.placeExpanded({ x: 500, y: 32 }, 0, { w: 400, h: 300 }, 1000, 700);
  assert.ok(top.top > 32 && top.edge === "top");
  const right = d.placeExpanded({ x: 968, y: 350 }, 1, { w: 400, h: 300 }, 1000, 700);
  assert.ok(right.left + right.width < 968, "opens toward the left of the right edge");
  const corner = d.placeExpanded({ x: 968, y: 40 }, 1, { w: 400, h: 300 }, 1000, 700);
  assert.ok(corner.top >= 8 && corner.left >= 8 && corner.left + corner.width <= 992 && corner.top + corner.height <= 692);
  const tiny = d.placeExpanded({ x: 10, y: 10 }, 0, { w: 400, h: 300 }, 200, 150);
  assert.ok(tiny.width <= 184 && tiny.height <= 134);
});

test("a spring settles on its target and never overshoots by much", () => {
  const d = dock();
  const spring = d.createSpring({ value: 0 });
  spring.setTarget(100);
  let peak = 0;
  for (let i = 0; i < 600 && !spring.settled(); i += 1) peak = Math.max(peak, spring.step(1 / 60));
  assert.ok(spring.settled());
  near(spring.value, 100, 1e-9);
  assert.ok(peak < 108, `overshoot ${peak} is too bouncy`);
});

test("a spring given a huge time step stays stable", () => {
  const d = dock();
  const spring = d.createSpring({ value: 0 });
  spring.setTarget(50);
  for (let i = 0; i < 40; i += 1) spring.step(5);
  assert.ok(Number.isFinite(spring.value) && Math.abs(spring.value) < 200);
});

test("a spring aimed across the wrap-around takes the short way round the loop", () => {
  const d = dock();
  const length = 1000;
  const spring = d.createSpring({ value: 995 });
  d.retarget(spring, 5, length);
  near(spring.target, 1005);
  const back = d.createSpring({ value: 5 });
  d.retarget(back, 995, length);
  near(back.target, -5);
  const mid = d.createSpring({ value: 100 });
  d.retarget(mid, 400, length);
  near(mid.target, 400);
});
