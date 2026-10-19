import { loadConfig } from "./config.js";
import { createApp } from "./http.js";

const config = loadConfig();
const app = await createApp(config);
app.server.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exitCode = 1;
});

app.server.listen(config.port, config.host, () => {
  const address = app.server.address();
  console.info(`Dogfight server listening on http://${config.host}:${address.port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
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
  } catch (error) {
    clearTimeout(forceExit);
    console.error("Server shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  void shutdown("unhandledRejection");
});
