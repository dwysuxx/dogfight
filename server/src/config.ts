import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type NetSim, NetSimSchema } from "@dogfight/shared/protocol.ts";

const SERVER_ROOT = fileURLToPath(new URL("../", import.meta.url));

// An optional integer from the environment: missing or "" gives the default,
// anything else must parse as an integer in range.
function intSetting(name: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === "") return fallback;
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
      ctx.addIssue({ code: "custom", message: `${name} must be an integer between ${min} and ${max}` });
      return z.NEVER;
    });
}

function numberSetting(name: string, fallback: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === "") return fallback;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
      ctx.addIssue({ code: "custom", message: `${name} must be a number` });
      return z.NEVER;
    });
}

// The environment is a boundary like any other: one schema, defaults included,
// and ServerConfig is inferred from it.
const EnvSchema = z
  .object({
    HOST: z
      .string()
      .optional()
      .transform((host) => host || "127.0.0.1")
      .refine((host) => !/[\s/\\]/.test(host), "HOST must be a hostname or IP address"),
    PORT: intSetting("PORT", 3000, { min: 0, max: 65535 }),
    MAX_ROOMS: intSetting("MAX_ROOMS", 100, { min: 2 }),
    MAX_PLAYERS_PER_ROOM: intSetting("MAX_PLAYERS_PER_ROOM", 16, { max: 255 }),
    MAX_PAYLOAD: intSetting("MAX_PAYLOAD", 16 * 1024, { min: 256 }),
    // Inputs alone are 30/s (one per tick), plus pings and chat.
    MAX_MESSAGES_PER_SECOND: intSetting("MAX_MESSAGES_PER_SECOND", 60),
    SLOW_CLIENT_BYTES: intSetting("SLOW_CLIENT_BYTES", 512 * 1024),
    LOG_DIR: z.string().optional(),
    JOIN_TIMEOUT_MS: intSetting("JOIN_TIMEOUT_MS", 5000),
    HEARTBEAT_MS: intSetting("HEARTBEAT_MS", 15000),
    // Default network conditions for every connection; each connection can
    // override them with ?lag=&jitter=&drop= or a netsim message.
    NET_LAG_MS: numberSetting("NET_LAG_MS", 0),
    NET_JITTER_MS: numberSetting("NET_JITTER_MS", 0),
    NET_DROP: numberSetting("NET_DROP", 0),
  })
  .transform((env, ctx) => {
    const netsim = NetSimSchema.safeParse({ lag: env.NET_LAG_MS, jitter: env.NET_JITTER_MS, drop: env.NET_DROP });
    if (!netsim.success) {
      ctx.addIssue({ code: "custom", message: `NET_LAG_MS / NET_JITTER_MS / NET_DROP out of range` });
      return z.NEVER;
    }
    return {
      host: env.HOST,
      port: env.PORT,
      maxRooms: env.MAX_ROOMS,
      maxPlayersPerRoom: env.MAX_PLAYERS_PER_ROOM,
      maxPayload: env.MAX_PAYLOAD,
      maxMessagesPerSecond: env.MAX_MESSAGES_PER_SECOND,
      slowClientBytes: env.SLOW_CLIENT_BYTES,
      logDir: resolve(SERVER_ROOT, env.LOG_DIR || "logs"),
      clientDist: resolve(SERVER_ROOT, "../client/dist"),
      joinTimeoutMs: env.JOIN_TIMEOUT_MS,
      heartbeatMs: env.HEARTBEAT_MS,
      netsim: netsim.data satisfies NetSim,
    };
  });

export type ServerConfig = z.output<typeof EnvSchema>;

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  throw new RangeError(parsed.error.issues.map((issue) => issue.message).join("; "));
}
