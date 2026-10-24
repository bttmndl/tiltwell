export type HudSnapshot = {
  label: string;
  count: number;
  source: "phone" | "hand";
};

type Bounds = { left: number; top: number; right: number; bottom: number };

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  m: number;
  color: number;
  angle: number;
  spin: number;
  squash: number;
  squashX: number;
  squashY: number;
  guard: number;
  sink: number;
};

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
};

type Palette = { body: string; lite: string; dark: string; seam: string };

const PALETTE: Palette[] = [
  { body: "#f6f3ec", lite: "#ffffff", dark: "#c9c2b4", seam: "#b7ad9c" },
];

const BALL_COUNT = 11;
const MAX_BALLS = 12;
const GRAVITY = 1180;
const DEG = Math.PI / 180;
const STEP = 1 / 120;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function screenAngle() {
  const angle = screen.orientation?.angle;
  if (typeof angle === "number") return angle;
  const legacy = (window as Window & { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

/** Gravity components in the device plane: +x device-right, +y device-top. */
function deviceGravity(gammaDeg: number, betaDeg: number) {
  const g = clamp(gammaDeg, -89, 89) * DEG;
  const b = clamp(betaDeg, -175, 175) * DEG;
  return {
    x: Math.sin(g),
    y: -Math.sin(b),
  };
}

/** Device-plane vector → screen space (+x right, +y down), angle clockwise. */
function toScreen(devX: number, devY: number, angleDeg: number) {
  const t = angleDeg * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return {
    x: devX * c + devY * s,
    y: devX * s - devY * c,
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

import type { PassedBall } from "@/lib/table-link";

export type WellSimOptions = {
  canvas: HTMLCanvasElement;
  getInsets: () => { top: number; bottom: number; side: number };
  onHud: (hud: HudSnapshot) => void;
  onPass?: (ball: PassedBall) => boolean;
};

export class WellSim {
  restitution = 0.58;
  muted = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly getInsets: WellSimOptions["getInsets"];
  private readonly onHud: WellSimOptions["onHud"];
  private readonly onPass: WellSimOptions["onPass"];
  private holeOpen = false;

  private balls: Ball[] = [];
  private sparks: Spark[] = [];
  private bounds: Bounds = { left: 16, top: 96, right: 360, bottom: 520 };
  private cssW = 1;
  private cssH = 1;
  private layoutW = 1;
  private layoutH = 1;
  private haveLayout = false;
  private didPour = false;
  private pourLeft = 0;
  private pourAcc = 0;
  private heroSpawned = false;

  private gamma = 0;
  private beta = 76;
  private targetGamma = 0;
  private targetBeta = 76;
  private screenBias = 0;
  private gx = 0;
  private gy = GRAVITY;
  private useDevice = false;
  private deviceArmed = false;
  private permissionGranted = false;
  private ignoreSensor = false;
  private baseGamma: number | null = null;
  private baseBeta: number | null = null;
  private orientLive = false;
  private lastPitch = 55;
  private neutralBeta: number | null = null;
  private sensorHits = 0;
  private gyroGamma = 0;
  private gyroBeta = 0;
  private lastGyroStamp = 0;
  private gravitySensor: { stop: () => void } | null = null;
  private lastDeviceEvent = 0;
  private motionMode = false;
  private sensorX = 0;
  private sensorY = 1;
  private targetSensorX = 0;
  private targetSensorY = 1;

  private keys = new Set<string>();
  private pointer: { id: number; x: number; y: number; moved: boolean } | null = null;
  private audio: AudioContext | null = null;
  private lastTok = 0;
  private reduceMotion = false;

  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private felt: CanvasPattern | null = null;
  private lastLabel = "";
  private lastCount = -1;
  private lastSource: HudSnapshot["source"] | "" = "";

  private ro: ResizeObserver | null = null;

  constructor(opts: WellSimOptions) {
    this.canvas = opts.canvas;
    const ctx = opts.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    this.ctx = ctx;
    this.getInsets = opts.getInsets;
    this.onHud = opts.onHud;
    this.onPass = opts.onPass;
    this.recomputeGravity();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.bind();
    this.resize();
    this.last = performance.now();
    this.publishHud(true);
    this.raf = requestAnimationFrame(this.frame);
    window.__tiltwell = {
      setLean: (deg: number) => this.setLean(deg),
      sample: () => this.sample(),
      ready: () => this.balls.length > 0,
    };
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.unbind();
    this.audio?.close().catch(() => {});
    this.audio = null;
    if (window.__tiltwell) delete window.__tiltwell;
  }

  setBounce(value: number) {
    this.restitution = clamp(value, 0.2, 0.96);
  }

  setMuted(value: boolean) {
    this.muted = value;
  }

  unlock() {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!this.audio) this.audio = new Ctor();
    if (this.audio.state === "suspended") void this.audio.resume();
  }

  async requestPermission() {
    if (this.permissionGranted && this.useDevice) return true;
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const DME = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    const asks: Promise<string>[] = [];
    try {
      if (typeof DME.requestPermission === "function") {
        asks.push(DME.requestPermission().catch(() => "denied"));
      }
      if (typeof DOE.requestPermission === "function") {
        asks.push(DOE.requestPermission().catch(() => "denied"));
      }
    } catch {
      return false;
    }
    if (asks.length === 0) {
      this.permissionGranted = true;
      this.armPhone();
      return true;
    }
    const results = await Promise.all(asks);
    this.permissionGranted = results.some((result) => result === "granted");
    if (this.permissionGranted) this.armPhone();
    return this.permissionGranted;
  }

  armPhone() {
    this.permissionGranted = true;
    this.ignoreSensor = false;
    this.gyroGamma = 0;
    this.gyroBeta = 0;
    this.lastGyroStamp = 0;
    this.listenSensors();
  }

  setHoleOpen(open: boolean) {
    this.holeOpen = open;
  }

  isTracking() {
    return this.sensorHits > 0;
  }

  arrive(ball: PassedBall) {
    if (!this.haveLayout) return;
    if (this.balls.length >= MAX_BALLS + 6) return;
    const h = this.holeCenter();
    const r = this.baseRadius();
    const speed = clamp(ball.speed, 180, 420);
    const made = this.makeBall(h.x, h.y, r, 0, speed * 0.72, speed * 0.62);
    made.spin = ball.spin;
    made.angle = ball.angle;
    made.guard = 0.7;
    made.sink = 0.92;
    this.balls.push(made);
  }

  addBall(x?: number, y?: number) {
    this.unlock();
    if (!this.haveLayout) return;
    if (this.balls.length >= MAX_BALLS) return;
    const b = this.bounds;
    const r = this.baseRadius();
    const px = clamp(x ?? (b.left + b.right) / 2, b.left + r, b.right - r);
    const py = clamp(y ?? b.top + r + 6, b.top + r, b.bottom - r);
    this.balls.push(this.makeBall(px, py, r, 0, (Math.random() - 0.5) * 80, 60));
  }

  shake() {
    this.unlock();
    for (const b of this.balls) {
      b.vx += (Math.random() - 0.5) * 1100;
      b.vy -= 480 + Math.random() * 520;
      b.squash = 0.55;
      b.squashX = 0;
      b.squashY = -1;
    }
  }

  reset() {
    this.unlock();
    this.balls = [];
    this.heroSpawned = false;
    this.pour();
  }

  level() {
    this.neutralBeta = this.lastPitch;
    this.screenBias = 0;
    this.recomputeGravity();
  }

  private setLean(deg: number) {
    this.ignoreSensor = true;
    this.useDevice = false;
    this.motionMode = false;
    this.deviceArmed = false;
    this.lastDeviceEvent = 0;
    this.screenBias = 0;
    this.targetGamma = deg;
    this.gamma = deg;
    this.targetBeta = 76;
    this.beta = 76;
    this.recomputeGravity();
  }

  private sample() {
    let x = 0;
    let y = 0;
    for (const b of this.balls) {
      x += b.x;
      y += b.y;
    }
    const n = this.balls.length || 1;
    return {
      count: this.balls.length,
      cx: x / n,
      cy: y / n,
      gx: this.gx,
      gy: this.gy,
      lean: (Math.atan2(this.gx, this.gy) * 180) / Math.PI,
    };
  }

  private baseRadius() {
    const w = this.bounds.right - this.bounds.left;
    return clamp(w * 0.046, 18, 30);
  }

  private makeBall(x: number, y: number, r: number, color: number, vx: number, vy: number): Ball {
    return {
      x,
      y,
      vx,
      vy,
      r,
      m: r * r,
      color: color % PALETTE.length,
      angle: Math.random() * Math.PI * 2,
      spin: 0,
      squash: 0,
      squashX: 0,
      squashY: 1,
      guard: 0,
      sink: 0,
    };
  }

  private pour() {
    this.pourLeft = BALL_COUNT;
    this.pourAcc = 0;
  }

  private spawnFalling() {
    const b = this.bounds;
    const r = this.baseRadius();
    const span = Math.max(8, b.right - b.left - r * 2);
    const x = b.left + r + Math.random() * span;
    const y = b.top + r + 1;
    this.balls.push(this.makeBall(x, y, r, 0, (Math.random() - 0.5) * 140, 50 + Math.random() * 90));
  }

  private bind() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.listenSensors();
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
  }

  private unbind() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.silenceSensors();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.ro?.disconnect();
    this.ro = null;
  }

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const bw = Math.floor(w * dpr);
    const bh = Math.floor(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
    this.layoutBounds();
  };

  private layoutBounds() {
    const insets = this.getInsets();
    const left = insets.side;
    const right = Math.max(left + 40, this.cssW - insets.side);
    const top = insets.top;
    const bottom = Math.max(top + 40, this.cssH - insets.bottom);
    const w = right - left;
    const h = bottom - top;
    if (this.haveLayout && this.balls.length) {
      const sx = w / this.layoutW;
      const sy = h / this.layoutH;
      if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
        for (const ball of this.balls) {
          ball.x = left + (ball.x - this.bounds.left) * sx;
          ball.y = top + (ball.y - this.bounds.top) * sy;
          ball.r = clamp(ball.r * ((sx + sy) / 2), 8, Math.min(w, h) * 0.18);
          ball.m = ball.r * ball.r;
        }
      }
    }
    this.bounds = { left, top, right, bottom };
    this.layoutW = w;
    this.layoutH = h;
    const ready = w > 40 && h > 80;
    if (ready && !this.didPour) {
      this.haveLayout = true;
      this.didPour = true;
      this.pour();
    } else if (ready) {
      this.haveLayout = true;
    }
  }

  private frame = (t: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 8) {
      this.tick(STEP);
      this.acc -= STEP;
      steps += 1;
    }
    this.draw();
    this.publishHud(false);
    this.raf = requestAnimationFrame(this.frame);
  };

  private handControl() {
    return !this.useDevice || performance.now() - this.lastDeviceEvent > 700;
  }

  private tick(dt: number) {
    if (this.motionMode && this.useDevice) {
      const k = 1 - Math.exp(-6 * dt);
      this.sensorX += (this.targetSensorX - this.sensorX) * k;
      this.sensorY += (this.targetSensorY - this.sensorY) * k;
    } else if (this.handControl()) {
      const rate = 64;
      if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) this.targetGamma -= rate * dt;
      if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) this.targetGamma += rate * dt;
      if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) this.targetBeta -= rate * dt;
      if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) this.targetBeta += rate * dt;
      this.targetGamma = clamp(this.targetGamma, -62, 62);
      this.targetBeta = clamp(this.targetBeta, -40, 105);
      const k = 1 - Math.exp(-12 * dt);
      this.gamma += (this.targetGamma - this.gamma) * k;
      this.beta += (this.targetBeta - this.beta) * k;
    } else {
      const k = 1 - Math.exp(-8 * dt);
      this.gamma += (this.targetGamma - this.gamma) * k;
      this.beta += (this.targetBeta - this.beta) * k;
    }
    this.recomputeGravity();

    if (this.pourLeft > 0) {
      this.pourAcc += dt;
      while (this.pourLeft > 0 && this.pourAcc >= 0.06) {
        this.pourAcc -= 0.06;
        this.pourLeft -= 1;
        this.spawnFalling();
      }
    }

    const drag = Math.exp(-0.7 * dt);
    for (const b of this.balls) {
      b.vx += this.gx * dt;
      b.vy += this.gy * dt;
      b.vx *= drag;
      b.vy *= drag;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 980) {
        b.vx = (b.vx / sp) * 980;
        b.vy = (b.vy / sp) * 980;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.squash *= Math.exp(-8 * dt);
    }

    const e = clamp(this.restitution, 0.15, 0.96);
    for (let iter = 0; iter < 4; iter += 1) {
      this.solveBalls(iter === 0 ? e : 0, dt, iter === 0);
      this.solveWalls(iter === 0 ? e : 0, dt, iter === 0);
    }
    this.drain(dt);

    const glen = Math.hypot(this.gx, this.gy) || 1;
    const tx = -this.gy / glen;
    const ty = this.gx / glen;
    for (const b of this.balls) {
      const tangential = b.vx * tx + b.vy * ty;
      const target = tangential / Math.max(8, b.r);
      b.spin += (target - b.spin) * (1 - Math.exp(-3.5 * dt));
      b.angle += b.spin * dt;
    }

    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx += this.gx * dt * 0.35;
      s.vy += this.gy * dt * 0.35;
    }
  }

  private rawScreen() {
    if (this.useDevice && this.motionMode) {
      return { x: this.sensorX, y: this.sensorY };
    }
    if (this.useDevice) {
      const dev = deviceGravity(this.gamma, this.beta);
      const screen = toScreen(dev.x, dev.y, screenAngle());
      return { x: screen.x * 1.85, y: screen.y };
    }
    return {
      x: Math.sin(clamp(this.gamma, -80, 80) * DEG),
      y: Math.sin(clamp(this.beta, -80, 120) * DEG),
    };
  }

  private recomputeGravity() {
    const raw = this.rawScreen();
    const c = Math.cos(this.screenBias);
    const s = Math.sin(this.screenBias);
    let x = raw.x * c - raw.y * s;
    let y = raw.x * s + raw.y * c;
    const scale = GRAVITY;
    x *= scale;
    y *= scale;
    const mag = Math.hypot(x, y);
    const cap = scale * 1.15;
    if (mag > cap) {
      x = (x / mag) * cap;
      y = (y / mag) * cap;
    }
    this.gx = x;
    this.gy = y;
  }

  private solveBalls(e: number, dt: number, friction: boolean) {
    const list = this.balls;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        const min = a.r + b.r;
        if (dist < 1e-4) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        if (dist >= min) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = min - dist;
        const invA = 1 / a.m;
        const invB = 1 / b.m;
        const inv = invA + invB;
        const corr = Math.max(overlap - 0.35, 0) * 0.8;
        if (corr > 0) {
          a.x -= nx * corr * (invA / inv);
          a.y -= ny * corr * (invA / inv);
          b.x += nx * corr * (invB / inv);
          b.y += ny * corr * (invB / inv);
        }
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          const impact = -rv;
          const useE = impact < 36 ? 0 : e / (1 + impact / 720);
          const j = (-(1 + useE) * rv) / inv;
          a.vx -= (j * nx) * invA;
          a.vy -= (j * ny) * invA;
          b.vx += (j * nx) * invB;
          b.vy += (j * ny) * invB;
          if (impact > 90) {
            a.squash = Math.max(a.squash, Math.min(1, impact / 1100));
            b.squash = Math.max(b.squash, Math.min(1, impact / 1100));
            a.squashX = nx;
            a.squashY = ny;
            b.squashX = -nx;
            b.squashY = -ny;
            this.burst((a.x + b.x) / 2, (a.y + b.y) / 2, nx, ny, impact);
            this.tok(impact);
          }
          if (friction) {
            const tx = -ny;
            const ty = nx;
            const tv = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
            const keep = Math.exp(-4.5 * dt);
            const change = tv * (keep - 1);
            a.vx -= change * tx * (invA / inv);
            a.vy -= change * ty * (invA / inv);
            b.vx += change * tx * (invB / inv);
            b.vy += change * ty * (invB / inv);
          }
        }
      }
    }
  }

  private holeCenter() {
    const r = Math.max(36, this.baseRadius() * 1.6);
    return { x: r * 0.78, y: r * 0.78, r };
  }

  private nearTrayCorner(b: Ball) {
    const h = this.holeCenter();
    return Math.hypot(b.x - h.x, b.y - h.y) < h.r * 0.62;
  }

  private drain(dt: number) {
    const h = this.holeCenter();
    const next: Ball[] = [];
    for (const b of this.balls) {
      if (b.guard > 0) {
        b.guard = Math.max(0, b.guard - dt);
        b.sink = Math.max(0, b.sink - dt / 0.34);
        if (b.guard <= 0) b.sink = 0;
        next.push(b);
        continue;
      }
      const leaving = b.sink > 0 || (this.holeOpen && this.nearTrayCorner(b));
      if (!leaving) {
        next.push(b);
        continue;
      }
      b.sink = Math.min(1, (b.sink || 0.01) + dt / 0.28);
      b.x += (h.x - b.x) * Math.min(1, dt * 8);
      b.y += (h.y - b.y) * Math.min(1, dt * 8);
      b.vx *= 0.5;
      b.vy *= 0.5;
      if (b.sink < 1) {
        next.push(b);
        continue;
      }
      const sent = this.onPass?.({ spin: b.spin, speed: Math.hypot(b.vx, b.vy) + 220, angle: b.angle }) ?? false;
      if (!sent) {
        b.sink = 0;
        b.guard = 0.55;
        b.x = h.x + h.r * 0.9;
        b.y = h.y + h.r * 0.9;
        b.vx = 220;
        b.vy = 180;
        next.push(b);
      }
    }
    this.balls = next;
  }

  private solveWalls(e: number, dt: number, friction: boolean) {
    const { left, top, right, bottom } = this.bounds;
    for (const b of this.balls) {
      if (b.sink > 0) continue;
      const mouth = this.holeOpen && (b.guard > 0 || b.sink > 0 || this.nearTrayCorner(b));
      if (!mouth && b.x < left + b.r) {
        b.x = left + b.r;
        this.bounceWall(b, 1, 0, e, dt, friction);
      } else if (b.x > right - b.r) {
        b.x = right - b.r;
        this.bounceWall(b, -1, 0, e, dt, friction);
      }
      if (!mouth && b.y < top + b.r) {
        b.y = top + b.r;
        this.bounceWall(b, 0, 1, e, dt, friction);
      } else if (b.y > bottom - b.r) {
        b.y = bottom - b.r;
        this.bounceWall(b, 0, -1, e, dt, friction);
      }
    }
  }

  private bounceWall(b: Ball, nx: number, ny: number, e: number, dt: number, friction: boolean) {
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const impact = -vn;
      const useE = impact < 40 ? 0 : e / (1 + impact / 640);
      b.vx -= (1 + useE) * vn * nx;
      b.vy -= (1 + useE) * vn * ny;
      if (impact > 80) {
        b.squash = Math.max(b.squash, Math.min(1, impact / 980));
        b.squashX = nx;
        b.squashY = ny;
        this.burst(b.x - nx * b.r, b.y - ny * b.r, nx, ny, impact);
        this.tok(impact);
      }
    }
    if (!friction) return;
    const tx = -ny;
    const ty = nx;
    const vt = b.vx * tx + b.vy * ty;
    const keep = Math.exp(-7.5 * dt);
    b.vx += vt * (keep - 1) * tx;
    b.vy += vt * (keep - 1) * ty;
  }

  private burst(x: number, y: number, nx: number, ny: number, impact: number) {
    if (this.reduceMotion || impact < 260) return;
    const count = impact > 620 ? 5 : 3;
    const tx = -ny;
    const ty = nx;
    for (let i = 0; i < count; i += 1) {
      let spark = this.sparks.find((s) => s.life <= 0);
      if (!spark) {
        if (this.sparks.length >= 56) return;
        spark = { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0 };
        this.sparks.push(spark);
      }
      const spray = (Math.random() - 0.5) * 2;
      const speed = 70 + Math.random() * impact * 0.22;
      spark.x = x;
      spark.y = y;
      spark.vx = nx * speed * 0.45 + tx * spray * speed;
      spark.vy = ny * speed * 0.45 + ty * spray * speed;
      spark.max = 0.22 + Math.random() * 0.16;
      spark.life = spark.max;
    }
  }

  private tok(speed: number) {
    if (this.muted || !this.audio || speed < 150) return;
    const now = this.audio.currentTime;
    if (now - this.lastTok < 0.028) return;
    this.lastTok = now;
    const osc = this.audio.createOscillator();
    const gain = this.audio.createGain();
    const filter = this.audio.createBiquadFilter();
    osc.type = "triangle";
    const freq = 120 + Math.min(speed, 1400) * 0.18;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.55), now + 0.07);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(980, now);
    const vol = Math.min(0.09, Math.max(0.01, speed / 7000));
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.audio.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  private describe() {
    if (this.gy < 0 && Math.abs(this.gx) <= Math.abs(this.gy) * 1.15) return "tipped up";
    const deg = Math.round((Math.atan2(this.gx, Math.max(this.gy, 1)) * 180) / Math.PI);
    const a = Math.abs(deg);
    if (a < 2) return "straight down";
    return deg < 0 ? `${a}° left` : `${a}° right`;
  }

  private publishHud(force: boolean) {
    const label = this.describe();
    const count = this.balls.length;
    const source: HudSnapshot["source"] = this.useDevice ? "phone" : "hand";
    if (!force && label === this.lastLabel && count === this.lastCount && source === this.lastSource) return;
    this.lastLabel = label;
    this.lastCount = count;
    this.lastSource = source;
    this.onHud({ label, count, source });
  }

  private ensureFelt() {
    if (this.felt) return;
    const tile = document.createElement("canvas");
    tile.width = 160;
    tile.height = 160;
    const g = tile.getContext("2d");
    if (!g) return;
    g.fillStyle = "#1a2621";
    g.fillRect(0, 0, 160, 160);
    for (let i = 0; i < 680; i += 1) {
      const lite = Math.random() > 0.74;
      g.fillStyle = lite ? "rgba(244,239,230,0.04)" : "rgba(0,0,0,0.18)";
      g.fillRect(Math.random() * 160, Math.random() * 160, lite ? 1 : 1.4, lite ? 1 : 2);
    }
    this.felt = this.ctx.createPattern(tile, "repeat");
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    ctx.fillStyle = "#101412";
    ctx.fillRect(0, 0, w, h);

    this.drawHole();

    const mag = Math.hypot(this.gx, this.gy) || 1;
    const dx = this.gx / mag;
    const dy = this.gy / mag;
    const order = this.balls.slice().sort((p, q) => p.x * dx + p.y * dy - (q.x * dx + q.y * dy));
    for (const ball of order) this.drawBall(ball, dx, dy);
  }

  private drawHole() {
    const ctx = this.ctx;
    const h = this.holeCenter();
    ctx.save();
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    const pit = ctx.createRadialGradient(h.x - h.r * 0.2, h.y - h.r * 0.25, h.r * 0.08, h.x, h.y, h.r);
    pit.addColorStop(0, "#000000");
    pit.addColorStop(0.72, "#141210");
    pit.addColorStop(1, this.holeOpen ? "#6a5030" : "#2c261e");
    ctx.fillStyle = pit;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = this.holeOpen ? "#c6a15b" : "#5c4c36";
    ctx.stroke();
    ctx.restore();
  }

  private drawLowEdge() {
    const ctx = this.ctx;
    const { left, top, right, bottom } = this.bounds;
    const ax = Math.abs(this.gx);
    const ay = Math.abs(this.gy);
    ctx.save();
    ctx.strokeStyle = "rgba(212,176,114,0.9)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (ay >= ax) {
      const y = this.gy >= 0 ? bottom - 14 : top + 14;
      ctx.moveTo(left + 36, y);
      ctx.lineTo(right - 36, y);
    } else {
      const x = this.gx >= 0 ? right - 14 : left + 14;
      ctx.moveTo(x, top + 36);
      ctx.lineTo(x, bottom - 36);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPlumb() {
    const ctx = this.ctx;
    const { left, top, right } = this.bounds;
    const ox = (left + right) / 2;
    const oy = top + 22;
    const mag = Math.hypot(this.gx, this.gy) || 1;
    const len = 58;
    const px = ox + (this.gx / mag) * len;
    const py = oy + (this.gy / mag) * len;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(px, py);
    ctx.strokeStyle = "rgba(212,176,114,0.75)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox, oy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#d4b072";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "#d4b072";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - 1.6, py - 1.8, 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fill();
  }

  private drawBall(b: Ball, dx: number, dy: number) {
    const ctx = this.ctx;
    const pal = PALETTE[b.color] ?? PALETTE[0];

    ctx.beginPath();
    ctx.ellipse(b.x + dx * b.r * 0.55, b.y + dy * b.r * 0.62, b.r * 0.86, b.r * 0.46, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fill();

    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.squash > 0.02) {
      const axis = Math.atan2(b.squashY, b.squashX);
      ctx.rotate(axis);
      ctx.scale(1 - b.squash * 0.16, 1 + b.squash * 0.09);
      ctx.rotate(-axis);
    }
    if (b.sink > 0) ctx.scale(1 - b.sink * 0.82, 1 - b.sink * 0.82);

    const r = b.r;
    const grd = ctx.createRadialGradient(-r * 0.28, -r * 0.32, r * 0.05, 0, 0, r * 1.05);
    grd.addColorStop(0, pal.lite);
    grd.addColorStop(0.42, pal.body);
    grd.addColorStop(1, pal.dark);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.4, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(b.angle);
    ctx.strokeStyle = pal.seam;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.ellipse(-r * 0.22, -r * 0.28, r * 0.34, r * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, r - 0.4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(90,80,64,0.18)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  private rivet(x: number, y: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = "#d4b072";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 1.1, y - 1.2, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fill();
  }

  private local(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.unlock();
    const p = this.local(e);
    this.pointer = { id: e.pointerId, x: p.x, y: p.y, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.pointer || e.pointerId !== this.pointer.id) return;
    const p = this.local(e);
    const dx = p.x - this.pointer.x;
    const dy = p.y - this.pointer.y;
    if (!this.pointer.moved && dx * dx + dy * dy > 36) this.pointer.moved = true;
    if (!this.pointer.moved || !this.handControl()) return;
    this.useDevice = false;
    this.targetGamma = clamp(this.targetGamma + dx * 0.28, -62, 62);
    this.targetBeta = clamp(this.targetBeta + dy * 0.18, -40, 105);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointer || e.pointerId !== this.pointer.id) return;
    this.pointer = null;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.code === "Space") {
      e.preventDefault();
      return;
    }
    if (
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown"
    ) {
      e.preventDefault();
    }
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private listenSensors() {
    this.silenceSensors();
    window.addEventListener("deviceorientation", this.onOrient);
    window.addEventListener("deviceorientationabsolute", this.onOrient);
    window.addEventListener("devicemotion", this.onMotion);
  }

  private silenceSensors() {
    window.removeEventListener("deviceorientation", this.onOrient);
    window.removeEventListener("deviceorientationabsolute", this.onOrient);
    window.removeEventListener("devicemotion", this.onMotion);
    this.gravitySensor?.stop();
    this.gravitySensor = null;
  }

  private applyTilt(rollDeg: number, pitchDeg: number) {
    const angle = ((screenAngle() % 360) + 360) % 360;
    let roll = rollDeg;
    let pitch = pitchDeg;
    if (angle === 90) {
      roll = pitchDeg;
      pitch = -rollDeg;
    } else if (angle === 270) {
      roll = -pitchDeg;
      pitch = rollDeg;
    } else if (angle === 180) {
      roll = -rollDeg;
      pitch = -pitchDeg;
    }
    this.lastPitch = pitch;
    if (this.neutralBeta == null) this.neutralBeta = pitch;
    const delta = pitch - this.neutralBeta;
    this.targetSensorX = Math.sin(clamp(roll, -55, 55) * DEG) * 1.2;
    this.targetSensorY = Math.sin(clamp(delta, -55, 55) * DEG) * 1.2;
    this.motionMode = true;
    this.useDevice = true;
    this.orientLive = true;
    this.deviceArmed = true;
    this.sensorHits += 1;
    this.lastDeviceEvent = performance.now();
  }

  private onOrient = (e: DeviceOrientationEvent) => {
    if (this.ignoreSensor) return;
    if (e.gamma == null || e.beta == null) return;
    if (Math.abs(e.gamma) < 0.35 && Math.abs(e.beta) < 0.35) return;
    this.applyTilt(e.gamma, e.beta);
  };

  private onMotion = (e: DeviceMotionEvent) => {
    if (this.ignoreSensor || this.orientLive) return;
    const reading = e.accelerationIncludingGravity;
    if (reading && reading.x != null && reading.y != null) {
      const mag = Math.hypot(reading.x, reading.y);
      const unit = mag > 3 ? 9.81 : 1;
      const x = -reading.x / unit;
      const y = -reading.y / unit;
      if (Math.hypot(x, y) > 0.2) {
        const screen = toScreen(x, y, screenAngle());
        const roll = (Math.asin(clamp(screen.x, -1, 1)) * 180) / Math.PI;
        const pitch = (Math.asin(clamp(screen.y, -1, 1)) * 180) / Math.PI;
        this.applyTilt(roll, pitch > 8 ? pitch : 50);
        return;
      }
    }
    this.integrateGyro(e);
  };

  private integrateGyro(e: DeviceMotionEvent) {
    const rate = e.rotationRate;
    if (!rate || rate.gamma == null || rate.beta == null) return;
    const stamp = e.timeStamp || performance.now();
    const dt = this.lastGyroStamp ? Math.min(0.05, (stamp - this.lastGyroStamp) / 1000) : 0;
    this.lastGyroStamp = stamp;
    if (dt <= 0) return;
    const gammaRate = Math.abs(rate.gamma) < 0.6 ? 0 : rate.gamma;
    const betaRate = Math.abs(rate.beta) < 0.6 ? 0 : rate.beta;
    this.gyroGamma = clamp(this.gyroGamma + gammaRate * dt, -75, 75);
    this.gyroBeta = clamp(this.gyroBeta + betaRate * dt, -70, 70);
    if (Math.abs(this.gyroGamma) < 0.7 && Math.abs(this.gyroBeta) < 0.7) return;
    this.applyTilt(this.gyroGamma, 76 + this.gyroBeta);
    this.orientLive = false;
  }

}

declare global {
  interface Window {
    __tiltwell?: {
      setLean: (deg: number) => void;
      sample: () => {
        count: number;
        cx: number;
        cy: number;
        gx: number;
        gy: number;
        lean: number;
      };
      ready: () => boolean;
    };
  }
}
