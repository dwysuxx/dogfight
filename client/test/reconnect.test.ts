import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadConfig } from "../../server/src/config.ts";
import { type App, createApp } from "../../server/src/http.ts";
import { GameConnection } from "../src/connection.ts";

// Chaos: the server process dies mid-match (a deploy, a crash) and a new one
// comes up on the same address. The real client connection must notice,
// back off, reconnect and re-join the room on its own.
const quietLogger = { error() {}, info() {}, warn() {} };

async function start(directory: string, port: number): Promise<App> {
  const config = loadConfig({ HOST: "127.0.0.1", PORT: String(port), LOG_DIR: join(directory, "logs") });
  const app = await createApp({ ...config, clientDist: join(directory, "dist") }, { logger: quietLogger });
  app.server.listen(port, "127.0.0.1");
  await once(app.server, "listening");
  return app;
}

test("chaos: after a server restart the client reconnects and re-joins its room", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dogfight-reconnect-"));
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "dist", "index.html"), "<!doctype html>");
  let app = await start(directory, 0);
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;

  const connection = new GameConnection({ url: `ws://127.0.0.1:${port}/ws`, codec: "binary", maxReconnectAttempts: 10 });
  try {
    const joins: string[] = [];
    const closes: number[] = [];
    connection.events.on("joined", (message) => joins.push(message.room));
    connection.events.on("close", ({ code }) => closes.push(code));
    await connection.connect({ room: "orbit", name: "Survivor" });

    await app.close(); // the old process goes away: players get 1001
    assert.deepEqual(closes, [1001]);
    app = await start(directory, port);

    const started = performance.now();
    while (joins.length < 2) {
      if (performance.now() - started > 8000) assert.fail("the client did not re-join within 8 s");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(joins, ["orbit", "orbit"]);
    assert.equal(app.rooms.get("orbit")?.players.size, 1, "the new server has the player back");
  } finally {
    connection.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
