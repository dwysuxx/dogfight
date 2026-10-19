import { createAudio } from "./audio.js";
import { fetchJson, loadAll, withRetry } from "./assets/loader.js";
import { botControls } from "./ai.js";
import { createInput, readControls } from "./input.js";
import { Lobby } from "./lobby/lobby.js";
import { createLobbyView } from "./lobby/view.js";
import { createLoop } from "./loop.js";
import { createGame } from "./sim/game.js";
import { setupCanvas } from "./render/canvas.js";
import { drawEntity, drawGrid, drawHud } from "./render/draw.js";
import { createGameHud } from "./render/hud.js";

const canvas = document.getElementById("game");
const hud = document.getElementById("hud");
const gameHud = document.getElementById("game-hud");
const lobbyRoot = document.getElementById("lobby");
const loading = document.getElementById("loading");
const loadingStatus = document.getElementById("loading-status");
const progressBar = document.getElementById("loading-progress");
const progressLabel = document.getElementById("loading-percent");
const retryButton = document.getElementById("retry-loading");
const backButton = document.getElementById("back-to-lobby");
const { ctx, getSize } = setupCanvas(canvas);
const lobby = new Lobby();

let loop = null;
let gameHudView = null;
let audio = null;
let loadController = null;
let selectedJoin = null;

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
      if (audio.context.state !== "running")
        console.warn("Audio is still locked until the next user gesture.");
    }
    const arena = room.arena ?? assets.arena;
    const { world, player, bot } = createGame({
      width: arena.width,
      height: arena.height,
      seed: Number(new URLSearchParams(location.search).get("seed")) || 1,
      asteroids: arena.asteroids ?? assets.arena.asteroids,
    });
    player.name = playerName;

    if (audio) audio.connect(world);
    const input = createInput(window);
    gameHudView?.dispose();
    gameHudView = createGameHud(gameHud, world, { player, bot });
    let paused = false;

    loop?.stop();
    loop = createLoop({
      step: 1 / 60,
      simulate(dt) {
        if (input.justPressed("KeyP")) paused = !paused;
        if (!paused) {
          world.step(
            dt,
            new Map([
              [player.id, readControls(input)],
              [bot.id, botControls(world, bot)],
            ]),
          );
        }
        input.update();
      },
      render(alpha) {
        const currentSize = getSize();
        ctx.clearRect(0, 0, currentSize.width, currentSize.height);
        const scale = Math.min(
          currentSize.width / world.bounds.width,
          currentSize.height / world.bounds.height,
        );
        const offsetX = (currentSize.width - world.bounds.width * scale) / 2;
        const offsetY = (currentSize.height - world.bounds.height * scale) / 2;
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        drawGrid(ctx, world.bounds.width, world.bounds.height);
        const interpolation = paused ? 1 : alpha;
        for (const entity of world)
          drawEntity(ctx, entity, interpolation, assets);
        ctx.restore();
        gameHudView.render(paused);
      },
      onStats(stats) {
        drawHud(hud, stats);
      },
    });

    loading.hidden = true;
    canvas.hidden = false;
    loop.start();
  } catch (error) {
    if (signal.aborted) return;
    showLoadingError(error);
  }
}

retryButton.addEventListener("click", () => {
  if (selectedJoin) void startGame(selectedJoin);
});
backButton.addEventListener("click", () => {
  loadController?.abort();
  loading.hidden = true;
  lobbyView.show();
  void lobby
    .refresh()
    .catch((error) => lobbyView.showError(`Could not refresh rooms: ${error.message}`))
    .finally(() => lobby.startPolling());
  if (audio) {
    void audio.dispose().catch((error) => console.error("Could not close audio:", error));
    audio = null;
  }
});

void lobby
  .refresh()
  .catch((error) => lobbyView.showError(`Could not load rooms: ${error.message}`))
  .finally(() => lobby.startPolling());
