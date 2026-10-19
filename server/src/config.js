import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = fileURLToPath(new URL("../", import.meta.url));

function integerSetting(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function loadConfig(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = integerSetting(env, "PORT", 3000, { min: 0, max: 65535 });
  const maxRooms = integerSetting(env, "MAX_ROOMS", 100, { min: 2 });
  const maxPlayersPerRoom = integerSetting(env, "MAX_PLAYERS_PER_ROOM", 16);
  const maxPayload = integerSetting(env, "MAX_PAYLOAD", 16 * 1024, { min: 256 });
  const maxMessagesPerSecond = integerSetting(env, "MAX_MESSAGES_PER_SECOND", 20);
  const slowClientBytes = integerSetting(env, "SLOW_CLIENT_BYTES", 512 * 1024);
  const logDir = resolve(SERVER_ROOT, env.LOG_DIR || "logs");
  const clientDist = resolve(SERVER_ROOT, "../client/dist");
  const joinTimeoutMs = integerSetting(env, "JOIN_TIMEOUT_MS", 5000);
  const heartbeatMs = integerSetting(env, "HEARTBEAT_MS", 15000);

  if (!host || /[\s/\\]/.test(host)) throw new TypeError("HOST must be a hostname or IP address");

  return {
    host,
    port,
    maxRooms,
    maxPlayersPerRoom,
    maxPayload,
    maxMessagesPerSecond,
    slowClientBytes,
    logDir,
    clientDist,
    joinTimeoutMs,
    heartbeatMs,
  };
}
