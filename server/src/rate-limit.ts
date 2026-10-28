// Token bucket: `ratePerSecond` tokens refill continuously up to `burst`;
// every message takes one. The clock is injected so tests can drive time.
export interface TokenBucket {
  take(): boolean;
  readonly tokens: number;
}

export function createTokenBucket({
  ratePerSecond,
  burst = ratePerSecond,
  now = Date.now,
}: {
  ratePerSecond: number;
  burst?: number;
  now?: () => number;
}): TokenBucket {
  let tokens = burst;
  let updatedAt = now();
  return {
    take() {
      const time = now();
      tokens = Math.min(burst, tokens + ((time - updatedAt) / 1000) * ratePerSecond);
      updatedAt = time;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get tokens() {
      return tokens;
    },
  };
}
