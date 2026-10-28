import { TICK_SECONDS } from "@dogfight/shared/protocol/messages.js";
import { createAudio } from "./audio.js";
import { fetchJson, loadAll, withRetry } from "./assets/loader.js";
import { GameConnection } from "./connection.js";
import { createInput, readControls } from "./input.js";
import { Lobby } from "./lobby/lobby.js";
import { createLobbyView } from "./lobby/view.js";
import { createLoop } from "./loop.js";
import { createNetgraph } from "./net/netgraph.js";
import { GameSession } from "./net/session.js";
import { setupCanvas } from "./render/canvas.js";
import { drawEntity, drawGameHud, drawGrid } from "./render/draw.js";
import "./determinism.js";

const canvas = document.getElementById("game");
const hud = document.getElementById("hud");
const netgraphPlot = document.getElementById("netgraph-plot");
const gameHud = document.getElementById("game-hud");
const lobbyRoot = document.getElementById("lobby");
const loading = document.getElementById("loading");
const loadingStatus = document.getElementById("loading-status");
const progressBar = document.getElementById("loading-progress");
const progressLabel = document.getElementById("loading-percent");
const retryButton = document.getElementById("retry-loading");
const backButton = document.getElementById("back-to-lobby");
const gameChat = document.getElementById("game-chat");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const roomRoster = document.getElementById("room-roster");
const leaveGameButton = document.getElementById("leave-game");
const { ctx, getSize } = setupCanvas(canvas);
const lobby = new Lobby();

// Page options: ?codec=json|binary, ?lag=&jitter=&drop= (injected network
// conditions, applied by the server to this connection), ?chaos=1 (the
// determinism-break experiment: Math.random() inside the client's prediction).
const params = new URLSearchParams(location.search);
const codec = params.get("codec") === "json" ? "json" : "binary";
const netsimQuery = new URLSearchParams(
  ["lag", "jitter", "drop"].filter((key) => params.has(key)).map((key) => [key, params.get(key)]),
).toString();
const chaos = params.get("chaos") === "1";
// Deliberately non-deterministic: ±4% velocity noise per predicted step.
const breakDeterminism = (ship) => ship.vel.scaleInPlace(1 + (Math.random() - 0.5) * 0.08);

let loop = null;
let audio = null;
let loadController = null;
let activeInput = null;
let selectedJoin = null;
let gameConnection = null;
let session = null;
let netgraph = null;
let keyController = null;

function describeError(error) {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map((item) => item.message).join("; ")}`;
  return error?.message ?? String(error);
}

const lobbyView = createLobbyView(lobbyRoot, lobby, (joined) => {
  selectedJoin = joined;
  return startGame(joined);
});

function showLoadingError(error) {
  loadingStatus.textContent = `Could not load the game: ${describeError(error)}`;
  retryButton.hidden = false;
  backButton.hidden = false;
}

function renderGameHud() {
  const { player, bot } = session.hudState();
  if (!player) {
    gameHud.textContent = session.latestState ? "destroyed - respawning..." : "Waiting for game state…";
    return;
  }
  drawGameHud(gameHud, { player, bot, paused: false });
}

function stopSession() {
  loop?.stop();
  loop = null;
  activeInput?.dispose();
  activeInput = null;
  keyController?.abort();
  keyController = null;
  session?.dispose();
  session = null;
  netgraph = null;
  gameConnection?.close();
  gameConnection = null;
}

async function startGame({ room, playerName }) {
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
      audio = createAudio();
    } catch (error) {
      console.warn("Web Audio could not be initialized:", error);
    }
  }
  if (audio) {
    try {
      await audio.unlock();
    } catch (error) {
      console.warn("Audio could not be enabled; continuing without sound:", error);
    }
  }

  try {
    loadingStatus.textContent = "Connecting to the room…";
    stopSession();
    gameConnection = new GameConnection({ codec, query: netsimQuery ? `?${netsimQuery}` : "" });
    session = new GameSession({
      connection: gameConnection,
      arena: room.arena ?? { width: 960, height: 540 },
      perturb: chaos ? breakDeterminism : null,
    });
    chatMessages.replaceChildren();
    gameConnection.on("roster", ({ players }) => {
      roomRoster.textContent = `Pilots: ${players.map((player) => player.name).join(", ")}`;
    });
    gameConnection.on("chat", ({ player, text }) => {
      const item = document.createElement("li");
      item.textContent = `${player.name}: ${text}`;
      chatMessages.append(item);
      while (chatMessages.children.length > 100) chatMessages.firstElementChild.remove();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
    gameConnection.on("error", (error) => {
      roomRoster.textContent = `Connection: ${error.message}`;
    });
    gameConnection.on("reconnecting", ({ attempt }) => {
      roomRoster.textContent = `Reconnecting to room (attempt ${attempt})…`;
    });
    const joined = await gameConnection.connect({ room: room.id, name: playerName });
    session.arena = joined.arena;

    const manifest = await withRetry(
      (activeSignal) => fetchJson("/assets/manifest.json", { signal: activeSignal }),
      { signal },
    );
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

    if (audio) {
      audio.setBuffers(assets.sounds);
      audio.connect(session);
      if (audio.context.state !== "running")
        console.warn("Audio is still locked until the next user gesture.");
    }

    const input = createInput(window);
    activeInput = input;
    netgraph = createNetgraph({ text: hud, canvas: netgraphPlot, session });
    keyController = new AbortController();
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target instanceof HTMLInputElement || event.repeat) return;
        if (netgraph?.handleKey(event.code)) event.preventDefault();
      },
      { signal: keyController.signal },
    );

    let lastFrame = performance.now();
    loop = createLoop({
      // The client steps at the server's tick rate: one input per tick, the
      // same dt, so a predicted step and a server step are the same function.
      step: TICK_SECONDS,
      simulate() {
        const typing = document.activeElement === chatInput;
        session.step(typing ? { left: false, right: false, thrust: false, fire: false } : readControls(input));
        input.update();
      },
      render(alpha) {
        const now = performance.now();
        const frameSeconds = (now - lastFrame) / 1000;
        lastFrame = now;
        const arena = session.arena;
        const currentSize = getSize();
        ctx.clearRect(0, 0, currentSize.width, currentSize.height);
        const scale = Math.min(currentSize.width / arena.width, currentSize.height / arena.height);
        const offsetX = (currentSize.width - arena.width * scale) / 2;
        const offsetY = (currentSize.height - arena.height * scale) / 2;
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        drawGrid(ctx, arena.width, arena.height);
        for (const { entity, alpha: entityAlpha, offset } of session.renderables(now, frameSeconds, alpha)) {
          if (offset) {
            ctx.save();
            ctx.translate(offset.x, offset.y);
            drawEntity(ctx, entity, entityAlpha, assets);
            ctx.restore();
          } else {
            drawEntity(ctx, entity, entityAlpha, assets);
          }
        }
        ctx.restore();
        renderGameHud();
      },
      onStats(stats) {
        netgraph?.update(stats);
      },
    });

    loading.hidden = true;
    canvas.hidden = false;
    gameChat.hidden = false;
    leaveGameButton.hidden = false;
    loop.start();
  } catch (error) {
    if (signal.aborted) return;
    stopSession();
    showLoadingError(error);
  }
}

async function returnToLobby() {
  loadController?.abort();
  stopSession();
  gameChat.hidden = true;
  leaveGameButton.hidden = true;
  canvas.hidden = true;
  netgraphPlot.hidden = true;
  hud.textContent = "";
  loading.hidden = true;
  lobbyView.show();
  try {
    await lobby.refresh();
  } catch (error) {
    lobbyView.showError(`Could not refresh rooms: ${error.message}`);
  } finally {
    lobby.startPolling();
  }
}

retryButton.addEventListener("click", () => {
  if (selectedJoin) void startGame(selectedJoin);
});
backButton.addEventListener("click", () => {
  void returnToLobby();
});
leaveGameButton.addEventListener("click", () => {
  void returnToLobby();
});
document.getElementById("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !gameConnection) return;
  if (gameConnection.sendChat(text)) chatInput.value = "";
});

void lobby
  .refresh()
  .catch((error) => lobbyView.showError(`Could not load rooms: ${error.message}`))
  .finally(() => lobby.startPolling());
