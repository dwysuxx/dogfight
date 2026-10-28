import { loadConfig } from "./config.ts";
import { createApp } from "./http.ts";

const config = loadConfig();
const app = await createApp(config);
app.server.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exitCode = 1;
});

app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.info(`Dogfight server listening on http://${config.host}:${port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing server`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await app.close();
    clearTimeout(forceExit);
    console.info("Server shutdown complete");
  } catch (error: unknown) {
    clearTimeout(forceExit);
    console.error("Server shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled promise rejection:", reason);
  void shutdown("unhandledRejection");
});
