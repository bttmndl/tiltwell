import { joinRoom } from "trystero";

export type PassedBall = {
  spin: number;
  speed: number;
  angle: number;
  side: "left" | "right";
};

export function connectTable(handlers: {
  onCount: (others: number) => void;
  onBall: (ball: PassedBall) => void;
}) {
  const peers = new Set<string>();
  let cursor = 0;
  const room = joinRoom({ appId: "bttmndl.tiltwell.v1" }, "table");
  const pass = room.makeAction<PassedBall>("pass");

  const publish = () => handlers.onCount(peers.size);

  room.onPeerJoin = (id) => {
    peers.add(id);
    publish();
  };
  room.onPeerLeave = (id) => {
    peers.delete(id);
    publish();
  };
  pass.onMessage = (ball) => {
    if (!ball || typeof ball.speed !== "number") return;
    handlers.onBall({
      spin: Number(ball.spin) || 0,
      speed: Number(ball.speed) || 240,
      angle: Number(ball.angle) || 0,
      side: ball.side === "right" ? "left" : "right",
    });
  };

  return {
    send(ball: PassedBall) {
      const ids = [...peers];
      if (ids.length === 0) return false;
      const target = ids[cursor % ids.length];
      cursor += 1;
      void pass.send(ball, { target });
      return true;
    },
    close() {
      void room.leave();
    },
  };
}
