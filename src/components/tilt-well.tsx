import { useEffect, useRef, useState } from "react";
import { RotateCcw, Smartphone, Volume2, VolumeX, Waves } from "lucide-react";
import { WellSim, type HudSnapshot } from "@/lib/well-sim";

const STORE = "tiltwell-v1";

function motionNeedsGesture() {
  const DOE = DeviceOrientationEvent as unknown as { requestPermission?: unknown };
  return typeof DOE.requestPermission === "function";
}

export function TiltWell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const simRef = useRef<WellSim | null>(null);
  const gyroLock = useRef(false);
  const [hud, setHud] = useState<HudSnapshot>({
    label: "straight down",
    count: 0,
    source: "hand",
  });
  const [bounce, setBounce] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [denied, setDenied] = useState(false);
  const [phoneLike, setPhoneLike] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setPhoneLike(
      window.matchMedia("(pointer: coarse)").matches ||
        navigator.maxTouchPoints > 0 ||
        motionNeedsGesture(),
    );
    const sim = new WellSim({
      canvas,
      getInsets: () => ({
        top: (headerRef.current?.offsetHeight ?? 92) + 8,
        bottom: (footerRef.current?.offsetHeight ?? 148) + 8,
        side: 16,
      }),
      onHud: setHud,
    });
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const saved = JSON.parse(raw) as { bounce?: number; muted?: boolean };
        if (typeof saved.bounce === "number") {
          sim.setBounce(saved.bounce);
          setBounce(saved.bounce);
        }
        if (typeof saved.muted === "boolean") {
          sim.setMuted(saved.muted);
          setMuted(saved.muted);
        }
      }
    } catch {
      /* keep defaults */
    }
    simRef.current = sim;
    sim.start();
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, []);

  function askGyro() {
    const sim = simRef.current;
    if (!sim || gyroLock.current) return;
    gyroLock.current = true;
    sim.unlock();
    void sim.requestPermission().then((ok) => {
      setDenied(!ok);
      if (ok) sim.armPhone();
    }).finally(() => {
      window.setTimeout(() => {
        gyroLock.current = false;
      }, 500);
    });
  }

  function persist(nextBounce: number, nextMuted: boolean) {
    try {
      localStorage.setItem(STORE, JSON.stringify({ v: 1, bounce: nextBounce, muted: nextMuted }));
    } catch {
      /* ignore */
    }
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        aria-label="Felt tray of bouncy balls. Tilt the phone and gravity follows the gyro."
      />

      <header ref={headerRef} className="hud-safe pointer-events-none absolute inset-x-0 top-0 z-10 px-4">
        <div className="flex items-start justify-between gap-3 pt-4">
          <div className="min-w-0">
            <h1 className="font-display text-3xl leading-none font-medium tracking-tight">Tiltwell</h1>
            <p className="mt-2 max-w-64 text-sm leading-snug text-muted">
              Tap Use phone gyro, then tip the phone left.
            </p>
          </div>
          <p className="pointer-events-auto shrink-0 rounded-full border border-line bg-surface/90 px-3 py-2 text-sm font-medium text-brass tabular-nums">
            {hud.label}
          </p>
        </div>
      </header>

      <footer ref={footerRef} className="dock-safe pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3">
        <div className="pointer-events-auto mb-3 rounded-3xl border border-line bg-surface/90 p-3 backdrop-blur-md">
          {phoneLike && hud.source !== "phone" ? (
            <button
              type="button"
              className="mb-3 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brass text-sm font-medium text-bg"
              onTouchEnd={(event) => {
                event.preventDefault();
                askGyro();
              }}
              onClick={askGyro}
            >
              <Smartphone className="size-4" aria-hidden="true" />
              {denied ? "Try phone gyro again" : "Use phone gyro"}
            </button>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-brass text-sm font-medium text-bg transition-transform duration-150 active:scale-95"
              onClick={() => simRef.current?.shake()}
            >
              <Waves className="size-4" aria-hidden="true" />
              Shake
            </button>
            <button
              type="button"
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-bg text-sm font-medium text-fg transition-transform duration-150 active:scale-95"
              onClick={() => simRef.current?.reset()}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Reset
            </button>
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-fg"
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                simRef.current?.setMuted(next);
                simRef.current?.unlock();
                persist(bounce, next);
              }}
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
          </div>

          <label className="mt-3 flex flex-col gap-1">
            <span className="flex items-center justify-between text-xs text-muted">
              <span>{hud.count} balls · {hud.source === "phone" ? "phone gyro" : "tilt your phone"}</span>
              <span className="text-fg tabular-nums">Bounce {Math.round(bounce * 100)}</span>
            </span>
            <input
              type="range"
              min={0.32}
              max={0.94}
              step={0.01}
              value={bounce}
              aria-label="Bounce"
              onChange={(e) => {
                const value = Number(e.target.value);
                setBounce(value);
                simRef.current?.setBounce(value);
                persist(value, muted);
              }}
            />
          </label>

          <div className="mt-1 flex justify-end">
            <button
              type="button"
              className="h-11 px-3 text-sm text-muted"
              onClick={() => simRef.current?.level()}
            >
              Level
            </button>
          </div>
        </div>
      </footer>
    </main>
  );
}
