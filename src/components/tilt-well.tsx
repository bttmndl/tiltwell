import { useEffect, useRef } from "react";
import { WellSim } from "@/lib/well-sim";
import { connectTable, type PassedBall } from "@/lib/table-link";

export function TiltWell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<WellSim | null>(null);
  const gyroLock = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let send: (ball: PassedBall) => boolean = () => false;
    const sim = new WellSim({
      canvas,
      getInsets: () => ({ top: 0, bottom: 0, side: 0 }),
      onHud: () => {},
      onPass: (ball) => send(ball),
    });
    simRef.current = sim;
    const link = connectTable({
      onCount: (count) => sim.setHoleOpen(count > 0),
      onBall: (ball) => sim.arrive(ball),
    });
    send = (ball) => link.send(ball);
    sim.start();

    const goFull = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      if (document.fullscreenElement || doc.webkitFullscreenElement) return;
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
      if (req) void Promise.resolve(req()).catch(() => {});
    };
    const ask = () => {
      goFull();
      if (gyroLock.current) return;
      gyroLock.current = true;
      sim.unlock();
      const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
      const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
      const pending: Promise<string>[] = [];
      if (typeof DOE.requestPermission === "function") pending.push(DOE.requestPermission());
      if (typeof DME.requestPermission === "function") pending.push(DME.requestPermission());
      if (pending.length === 0) {
        sim.armPhone();
        return;
      }
      void Promise.all(pending.map((task) => task.catch(() => "denied"))).then((results) => {
        if (results.some((result) => result === "granted")) sim.armPhone();
        else gyroLock.current = false;
      });
    };
    canvas.addEventListener("pointerdown", ask);
    return () => {
      canvas.removeEventListener("pointerdown", ask);
      link.close();
      sim.stop();
      simRef.current = null;
    };
  }, []);

  return (
    <main className="fixed inset-0 h-[100dvh] w-full overflow-hidden bg-[#101412]">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        aria-label="Balls on the whole screen. The top-left hole leads to another phone."
      />
    </main>
  );
}
