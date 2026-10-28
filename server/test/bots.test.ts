import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { PROTOCOL_VERSION, check } from "@dogfight/shared/protocol.ts";
import { Asteroid } from "@dogfight/shared/sim/asteroid.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { Bot } from "../src/bots.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { Match } from "../src/match.ts";

const room = { id: "bots", arena: { width: 960, height: 540, asteroids: 0 }, maxPlayers: 8 };

function stepWithBots(match: Match, bots: Bot[], ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    for (const bot of bots) match.receiveInputs(bot.id, [bot.next(match.world, match.player(bot.id)?.ship)]);
    match.step();
  }
}

test("a Bot is just another input source: seq-numbered frames into Match.receiveInputs", () => {
  const match = new Match(room, { withBot: false });
  const bots = [new Bot("bot-a", "Bot A", 1), new Bot("bot-b", "Bot B", 2)];
  for (const bot of bots) match.join(bot);
  stepWithBots(match, bots, 300);
  for (const bot of bots) assert.equal(match.player(bot.id)?.lastProcessedSeq, 300, "every frame applied");
  assert.ok(match.stats.inputsApplied >= 600);
});

test("two bots find each other and shoot", () => {
  const match = new Match(room, { withBot: false });
  const bots = [new Bot("bot-a", "Bot A", 1), new Bot("bot-b", "Bot B", 2)];
  for (const bot of bots) match.join(bot);
  let shots = 0;
  match.world.events.on("fired", () => shots++);
  stepWithBots(match, bots, 30 * 20);
  assert.ok(shots > 10, `${shots} shots in 20 s`);
  const [a, b] = bots.map((bot) => match.player(bot.id)?.ship);
  assert.ok(a && b);
  assert.ok(a.score + b.score > 0 || a.hp < 100 || b.hp < 100, "someone got hit");
});

test("a bot turns away from an asteroid right ahead of it", () => {
  const match = new Match(room, { withBot: false });
  const bot = new Bot("bot-a", "Bot A", 1);
  match.join(bot);
  const ship = match.player(bot.id)?.ship;
  assert.ok(ship);
  ship.angle = 0;
  match.world.spawn(new Asteroid({ pos: ship.pos.add(new Vector2(60, 5)), vel: new Vector2(), radius: 25, rng: createRng(1) }));
  const { controls } = bot.next(match.world, ship);
  assert.ok(controls.left || controls.right, "turning");
  assert.equal(controls.fire, false, "not shooting at rocks while evading");
});

test("POST/DELETE /api/rooms/:id/bots, and bots leave with the last human", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dogfight-bots-"));
  const app = await createApp(
    { ...loadConfig({ PORT: "0", LOG_DIR: join(directory, "logs") }), clientDist: join(directory, "dist") },
    { logger: { info() {}, warn() {}, error() {} } },
  );
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  t.onTestFinished(async () => {
    socket.terminate();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  await once(socket, "open");
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Human" }));
  await once(socket, "message");

  const added = await fetch(`${base}/api/rooms/orbit/bots`, { method: "POST", body: JSON.stringify({ count: 3 }) });
  assert.equal(added.status, 201);
  const addedBody = check(z.object({ added: z.number() }), await added.json());
  assert.ok(addedBody.ok && addedBody.value.added === 3);
  const rooms = check(z.object({ rooms: z.array(z.object({ id: z.string(), players: z.number() })) }), await (await fetch(`${base}/api/rooms`)).json());
  assert.ok(rooms.ok);
  assert.equal(rooms.value.rooms.find((r) => r.id === "orbit")?.players, 4, "1 human + 3 bots");

  assert.equal((await fetch(`${base}/api/rooms/orbit/bots`, { method: "POST", body: JSON.stringify({ count: 999 }) })).status, 400);
  assert.equal((await fetch(`${base}/api/rooms/nope/bots`, { method: "POST", body: JSON.stringify({ count: 1 }) })).status, 404);

  const removed = await fetch(`${base}/api/rooms/orbit/bots`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  await fetch(`${base}/api/rooms/orbit/bots`, { method: "POST", body: JSON.stringify({ count: 2 }) });

  // The human leaves: the room must not keep running for bots alone.
  socket.close();
  await once(socket, "close");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = check(z.object({ matches: z.array(z.object({ room: z.string() })) }), await (await fetch(`${base}/api/stats`)).json());
  assert.ok(after.ok);
  assert.equal(after.value.matches.some((m) => m.room === "orbit"), false);
});
