import { loadConfig } from "./config.ts";
import { createApp } from "./http.ts";
import { createLogger } from "./log/logger.ts";

// Bad configuration is a deploy mistake: fail at once, loudly, before
// listening, so the platform never routes traffic to a half-configured box.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error: unknown) {
  console.error(JSON.stringify({ level: "fatal", msg: "invalid configuration", error: String(error) }));
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, version: config.version });
const app = await createApp(config, { logger });
app.server.on("error", (error) => {
  logger.fatal({ err: error }, "http server error");
  process.exit(1);
});

app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  logger.info(
    { host: config.host, port, commit: config.commit, node: process.version },
    "dogfight server listening",
  );
});

// SIGTERM from Docker/Fly: stop being ready, refuse new sockets, tell every
// player "going away" (1001, the client reconnects to the next instance),
// flush the match logs, exit 0 — all inside the platform's kill timeout.
// This only works because the container runs `node` as PID 1 (exec-form
// CMD); `npm start` would swallow the signal and get SIGKILLed instead.
let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const started = Date.now();
  logger.info({ signal }, "shutdown started");
  app.drain();
  const forceExit = setTimeout(() => {
    logger.fatal({ timeoutMs: config.shutdownTimeoutMs }, "graceful shutdown timed out");
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();
  try {
    await app.close();
    logger.info({ signal, durationMs: Date.now() - started }, "shutdown complete");
    process.exitCode = exitCode;
  } catch (error: unknown) {
    logger.fatal({ err: error }, "shutdown failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExit);
  }
}

// Started by a parent process (the load test): Windows has no SIGINT for
// child processes, so a graceful stop (which lets --cpu-prof write its
// profile) is requested over the IPC channel.
process.on("message", (message: unknown) => {
  if (message === "shutdown") void shutdown("ipc").finally(() => process.disconnect?.());
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// An error nobody expected leaves the process in an unknown state: log it,
// try to say goodbye to the players, exit non-zero and let the platform
// restart a clean process. Never "log and carry on".
function crash(kind: string, error: unknown): void {
  logger.fatal({ err: error, kind }, "crashing on unexpected error");
  void shutdown(kind, 1);
}
process.on("uncaughtException", (error) => crash("uncaughtException", error));
process.on("unhandledRejection", (reason: unknown) => crash("unhandledRejection", reason));
