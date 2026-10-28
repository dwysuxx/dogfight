// Every interval: a peer that has not answered the previous ping is
// terminated; everyone else is marked "not alive" and pinged again. A pong
// (handled by the caller) sets alive back to true.
export interface HeartbeatPeer {
  alive: boolean;
  readonly open: boolean;
  ping(): void;
  terminate(): void;
}

export function startHeartbeat(peers: () => Iterable<HeartbeatPeer>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    for (const peer of peers()) {
      if (!peer.alive) {
        peer.terminate();
        continue;
      }
      peer.alive = false;
      if (peer.open) peer.ping();
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
