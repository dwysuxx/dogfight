import { NO_CONTROLS, type RoomInfo, TICK_SECONDS } from "@dogfight/shared/protocol.ts";
import type { Ship } from "@dogfight/shared/sim/ship.ts";
import { type Assets, fetchJson, loadAll, withRetry } from "./assets/loader.ts";
import { type GameAudio, createAudio } from "./audio.ts";
import { GameConnection } from "./connection.ts";
import "./determinism.ts";
import { byId, errorMessage, storage } from "./dom.ts";
import { type Input, createInput, readControls } from "./input.ts";
import { type JoinSelection, Lobby } from "./lobby/lobby.ts";
import { createLobbyView } from "./lobby/view.ts";
import { type Loop, createLoop } from "./loop.ts";
import { type Netgraph, createNetgraph } from "./net/netgraph.ts";
import { GameSession } from "./net/session.ts";
import { setupCanvas } from "./render/canvas.ts";
import { drawEntity, drawGameHud, drawGrid } from "./render/draw.ts";

const canvas = byId("game", HTMLCanvasElement);
const hud = byId("hud", HTMLElement);
const netgraphPlot = byId("netgraph-plot", HTMLCanvasElement);
const gameHud = byId("game-hud", HTMLElement);
const lobbyRoot = byId("lobby", HTMLElement);
const loading = byId("loading", HTMLElement);
const loadingStatus = byId("loading-status", HTMLElement);
const progressBar = byId("loading-progress", HTMLProgressElement);
const progressLabel = byId("loading-percent", HTMLElement);
const retryButton = byId("retry-loading", HTMLButtonElement);
const backButton = byId("back-to-lobby", HTMLButtonElement);
const gameChat = byId("game-chat", HTMLElement);
const chatMessages = byId("chat-messages", HTMLOListElement);
const chatInput = byId("chat-input", HTMLInputElement);
const chatForm = byId("chat-form", HTMLFormElement);
const roomRoster = byId("room-roster", HTMLElement);
const leaveGameButton = byId("leave-game", HTMLButtonElement);
const muteButton = byId("mute-toggle", HTMLButtonElement);
const { ctx, getSize } = setupCanvas(canvas);
const lobby = new Lobby();

// Page options: ?codec=json|binary, ?lag=&jitter=&drop= (injected network
// conditions, applied by the server to this connection), ?chaos=1 (the
// determinism-break experiment: Math.random() inside the client's prediction).
const params = new URLSearchParams(location.search);
const codec = params.get("codec") === "json" ? "json" : "binary";
const netsimQuery = new URLSearchParams(
  ["lag", "jitter", "drop"].flatMap((key) => {
    const value = params.get(key);
    return value === null ? [] : [[key, value]];
  }),
).toString();
const chaos = params.get("chaos") === "1";
// Deliberately non-deterministic: ±4% velocity noise per predicted step.
const breakDeterminism = (ship: Ship) => {
  ship.vel = ship.vel.scale(1 + (Math.random() - 0.5) * 0.08);
};

const MUTE_KEY = "dogfight:muted";
let muted = storage.get(MUTE_KEY) === "1";

interface Running {
  connection: GameConnection;
  session: GameSession;
  netgraph: Netgraph | null;
  loop: Loop | null;
  input: Input | null;
  keys: AbortController;
  disconnectAudio: (() => void) | null;
}

let audio: GameAudio | null = null;
let loadController: AbortController | null = null;
let selectedJoin: JoinSelection | null = null;
let running: Running | null = null;

const lobbyView = createLobbyView(lobbyRoot, lobby, (joined) => {
  selectedJoin = joined;
  return startGame(joined);
});

function renderMute(): void {
  muteButton.textContent = muted ? "🔇 Sound off" : "🔊 Sound on";
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButton.title = `${muted ? "Unmute" : "Mute"} (M)`;
}

function toggleMute(): void {
  muted = !muted;
  storage.set(MUTE_KEY, muted ? "1" : "0");
  audio?.setMuted(muted);
  renderMute();
}

function showLoadingError(error: unknown): void {
  loadingStatus.textContent = `Could not load the game: ${errorMessage(error)}`;
  retryButton.hidden = false;
  backButton.hidden = false;
}

function renderGameHud(session: GameSession): void {
  const { player, bot } = session.hudState();
  if (!player) {
    gameHud.textContent = session.latestState ? "destroyed - respawning..." : "Waiting for game state…";
    return;
  }
  drawGameHud(gameHud, { player, bot });
}

function stopSession(): void {
  if (!running) return;
  running.loop?.stop();
  running.input?.dispose();
  running.keys.abort();
  running.disconnectAudio?.();
  running.netgraph?.dispose();
  running.session.dispose();
  running.connection.close();
  running = null;
}

function render(session: GameSession, assets: Assets, alpha: number, frameSeconds: number): void {
  const arena = session.arena;
  const size = getSize();
  ctx.clearRect(0, 0, size.width, size.height);
  const scale = Math.min(size.width / arena.width, size.height / arena.height);
  ctx.save();
  ctx.translate((size.width - arena.width * scale) / 2, (size.height - arena.height * scale) / 2);
  ctx.scale(scale, scale);
  drawGrid(ctx, arena.width, arena.height);
  for (const { entity, alpha: entityAlpha, offset } of session.renderables(performance.now(), frameSeconds, alpha)) {
    if (!offset) {
      drawEntity(ctx, entity, entityAlpha, assets);
      continue;
    }
    ctx.save();
    ctx.translate(offset.x, offset.y);
    drawEntity(ctx, entity, entityAlpha, assets);
    ctx.restore();
  }
  ctx.restore();
  renderGameHud(session);
}

async function startGame({ room, playerName }: { room: RoomInfo; playerName: string }): Promise<void> {
  lobby.stopPolling();
  lobbyView.hide();
  canvas.hidden = true;
  loading.hidden = false;
  retryButton.hidden = true;
  backButton.hidden = true;
  loadingStatus.textContent = "Preparing game…";
  progressBar.value = 0;
  progressLabel.textContent = "0%";
  loadController?.abort();
  loadController = new AbortController();
  const { signal } = loadController;

  if (!audio) {
    try {
      audio = createAudio({ muted });
    } catch (error: unknown) {
      console.warn("Web Audio could not be initialized:", error);
    }
  }
  try {
    await audio?.unlock();
  } catch (error: unknown) {
    console.warn("Audio could not be enabled; continuing without sound:", error);
  }
  muteButton.disabled = audio === null;

  try {
    loadingStatus.textContent = "Connecting to the room…";
    stopSession();
    const connection = new GameConnection({ codec, query: netsimQuery ? `?${netsimQuery}` : "" });
    const session = new GameSession({ connection, arena: room.arena, perturb: chaos ? breakDeterminism : null });
    const current: Running = {
      connection,
      session,
      netgraph: null,
      loop: null,
      input: null,
      keys: new AbortController(),
      disconnectAudio: null,
    };
    running = current;
    chatMessages.replaceChildren();
    connection.events.on("roster", ({ players }) => {
      roomRoster.textContent = `Pilots: ${players.map((player) => player.name).join(", ")}`;
    });
    connection.events.on("chat", ({ player, text }) => {
      const item = document.createElement("li");
      item.textContent = `${player.name}: ${text}`;
      chatMessages.append(item);
      while (chatMessages.children.length > 100) chatMessages.firstElementChild?.remove();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
    connection.events.on("error", (error) => {
      roomRoster.textContent = `Connection: ${error.message}`;
    });
    connection.events.on("reconnecting", ({ attempt }) => {
      roomRoster.textContent = `Reconnecting to room (attempt ${attempt})…`;
    });
    await connection.connect({ room: room.id, name: playerName });

    const manifest = await withRetry((activeSignal) => fetchJson("/assets/manifest.json", { signal: activeSignal }), { signal });
    loadingStatus.textContent = "Loading images, sounds, and arena…";
    const assets = await loadAll(manifest, {
      signal,
      audioContext: audio?.context,
      onProgress(ratio, completed, total) {
        progressBar.value = ratio;
        progressLabel.textContent = `${Math.round(ratio * 100)}%`;
        loadingStatus.textContent = `Loading resources (${completed}/${total})…`;
      },
      onWarning(key, error) {
        console.warn(`Optional resource ${key} could not be loaded:`, error);
      },
    });
    if (running !== current) return; // left while loading

    if (audio) {
      audio.setBuffers(assets.sounds);
      current.disconnectAudio = audio.connect(session.events);
    }

    const input = createInput(window);
    current.input = input;
    const netgraph = createNetgraph({ text: hud, canvas: netgraphPlot, session });
    current.netgraph = netgraph;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target instanceof HTMLInputElement || event.repeat) return;
        if (event.code === "KeyM") {
          toggleMute();
          event.preventDefault();
        } else if (netgraph.handleKey(event.code)) event.preventDefault();
      },
      { signal: current.keys.signal },
    );

    let lastFrame = performance.now();
    const loop = createLoop({
      // The client steps at the server's tick rate: one input per tick, the
      // same dt, so a predicted step and a server step are the same function.
      step: TICK_SECONDS,
      simulate() {
        session.step(document.activeElement === chatInput ? NO_CONTROLS : readControls(input));
        input.update();
      },
      render(alpha) {
        const now = performance.now();
        render(session, assets, alpha, (now - lastFrame) / 1000);
        lastFrame = now;
      },
      onStats: (stats) => netgraph.update(stats),
    });
    current.loop = loop;

    loading.hidden = true;
    canvas.hidden = false;
    gameChat.hidden = false;
    leaveGameButton.hidden = false;
    muteButton.hidden = false;
    loop.start();
  } catch (error: unknown) {
    if (signal.aborted) return;
    stopSession();
    showLoadingError(error);
  }
}

async function returnToLobby(): Promise<void> {
  loadController?.abort();
  stopSession();
  for (const element of [gameChat, leaveGameButton, muteButton, canvas, netgraphPlot, loading]) element.hidden = true;
  hud.textContent = "";
  gameHud.textContent = "";
  lobbyView.show();
  try {
    await lobby.refresh();
  } catch (error: unknown) {
    lobbyView.showError(`Could not refresh rooms: ${errorMessage(error)}`);
  } finally {
    lobby.startPolling();
  }
}

renderMute();
muteButton.addEventListener("click", () => {
  toggleMute();
  muteButton.blur(); // keep Space for firing, not for re-clicking the button
});
retryButton.addEventListener("click", () => {
  if (selectedJoin) void startGame(selectedJoin);
});
backButton.addEventListener("click", () => void returnToLobby());
leaveGameButton.addEventListener("click", () => void returnToLobby());
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !running) return;
  if (running.connection.sendChat(text)) chatInput.value = "";
});

void lobby
  .refresh()
  .catch((error: unknown) => lobbyView.showError(`Could not load rooms: ${errorMessage(error)}`))
  .finally(() => lobby.startPolling());
