import type { Arena, RoomInfo } from "@dogfight/shared/protocol.ts";
import { errorMessage, query, storage } from "../dom.ts";
import type { JoinSelection, Lobby } from "./lobby.ts";

const NAME_KEY = "dogfight:pilot";
const ARENAS = {
  small: { width: 960, height: 540, asteroids: 6 },
  large: { width: 1280, height: 720, asteroids: 10 },
} as const satisfies Record<string, Arena>;
const isArenaSize = (value: string): value is keyof typeof ARENAS => value in ARENAS;

const TEMPLATE = `
  <div class="lobby-shell">
    <header class="lobby-hero">
      <h1 class="logo">DOGFIGHT</h1>
      <p class="tagline">Realtime space combat · authoritative 30&nbsp;Hz server · client prediction</p>
    </header>
    <div class="lobby-grid">
      <section class="panel pilot-panel" aria-labelledby="pilot-heading">
        <h2 id="pilot-heading">Pilot</h2>
        <label class="field">
          <span>Callsign</span>
          <input id="pilot-name" maxlength="20" autocomplete="nickname" spellcheck="false" placeholder="Pilot">
        </label>
        <p class="hint">Remembered on this device.</p>
        <h2>Controls</h2>
        <dl class="keys">
          <dt><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd></dt><dd>Turn</dd>
          <dt><kbd>↑</kbd> / <kbd>W</kbd></dt><dd>Thrust</dd>
          <dt><kbd>Space</kbd></dt><dd>Fire</dd>
          <dt><kbd>M</kbd></dt><dd>Mute sound</dd>
          <dt><kbd>N</kbd></dt><dd>Netgraph</dd>
          <dt><kbd>L</kbd></dt><dd>Simulated lag</dd>
        </dl>
      </section>
      <section class="panel rooms-panel" aria-labelledby="rooms-heading">
        <div class="panel-head">
          <h2 id="rooms-heading">Rooms</h2>
          <button type="button" id="refresh-rooms" class="ghost" title="Refresh rooms">↻ Refresh</button>
        </div>
        <ul id="room-list" class="room-list" aria-live="polite"></ul>
        <form id="create-room-form" class="create-room">
          <input id="room-name" maxlength="40" required placeholder="New room name" aria-label="New room name">
          <select id="room-size" aria-label="Arena size">
            <option value="small">Small · 960×540</option>
            <option value="large">Large · 1280×720</option>
          </select>
          <button type="submit">Create</button>
        </form>
      </section>
    </div>
    <p id="lobby-status" class="status" role="status">Loading rooms…</p>
  </div>`;

export interface LobbyView {
  showError(message: string): void;
  hide(): void;
  show(): void;
  dispose(): void;
}

export function createLobbyView(
  root: HTMLElement,
  lobby: Lobby,
  onJoin: (joined: JoinSelection) => Promise<void> | void,
): LobbyView {
  const controller = new AbortController();
  const { signal } = controller;
  root.innerHTML = TEMPLATE;

  const status = query(root, "#lobby-status", HTMLElement);
  const roomList = query(root, "#room-list", HTMLUListElement);
  const pilotName = query(root, "#pilot-name", HTMLInputElement);
  const roomName = query(root, "#room-name", HTMLInputElement);
  const roomSize = query(root, "#room-size", HTMLSelectElement);
  pilotName.value = storage.get(NAME_KEY) ?? "Pilot";
  pilotName.addEventListener("change", () => storage.set(NAME_KEY, pilotName.value.trim()), { signal });

  const setStatus = (message: string, kind: "info" | "error" = "info") => {
    status.textContent = message;
    status.dataset["kind"] = kind;
  };

  function join(room: RoomInfo): void {
    try {
      storage.set(NAME_KEY, pilotName.value.trim());
      const joined = lobby.join(room.id, pilotName.value);
      setStatus(`Joining ${joined.room.name}…`);
      Promise.resolve(onJoin(joined)).catch((error: unknown) => setStatus(`Could not join room: ${errorMessage(error)}`, "error"));
    } catch (error: unknown) {
      setStatus(`Could not join room: ${errorMessage(error)}`, "error");
    }
  }

  // Room names come from other players: built with textContent, never innerHTML.
  function roomCard(room: RoomInfo): HTMLLIElement {
    const full = room.players >= room.capacity;
    const item = document.createElement("li");
    item.className = "room-card";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = room.name;
    const meta = document.createElement("span");
    meta.className = "room-meta";
    meta.textContent = `${room.arena.width}×${room.arena.height} · ${room.arena.asteroids} asteroids`;
    info.append(name, meta);

    const occupancy = document.createElement("div");
    occupancy.className = "occupancy";
    const bar = document.createElement("progress");
    bar.max = room.capacity;
    bar.value = room.players;
    const count = document.createElement("span");
    count.textContent = `${room.players}/${room.capacity}`;
    occupancy.append(bar, count);
    occupancy.title = `${room.players} of ${room.capacity} pilots`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = full ? "Full" : "Join";
    button.disabled = full;
    button.addEventListener("click", () => join(room), { signal });

    item.append(info, occupancy, button);
    return item;
  }

  function renderRooms(rooms: readonly RoomInfo[]): void {
    if (rooms.length === 0) {
      const empty = document.createElement("li");
      empty.className = "room-empty";
      empty.textContent = "No rooms yet — create one below.";
      roomList.replaceChildren(empty);
    } else {
      roomList.replaceChildren(...rooms.map(roomCard));
    }
    setStatus(`${rooms.length} room${rooms.length === 1 ? "" : "s"} · updated ${new Date().toLocaleTimeString()}`);
  }

  const offs = [
    lobby.events.on("roomsChanged", renderRooms),
    lobby.events.on("refreshError", (error) => setStatus(`Could not refresh rooms: ${errorMessage(error)}`, "error")),
  ];
  signal.addEventListener("abort", () => offs.forEach((off) => off()));

  query(root, "#refresh-rooms", HTMLButtonElement).addEventListener(
    "click",
    () => {
      setStatus("Refreshing rooms…");
      lobby.refresh().catch((error: unknown) => setStatus(`Could not refresh rooms: ${errorMessage(error)}`, "error"));
    },
    { signal },
  );
  query(root, "#create-room-form", HTMLFormElement).addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const size = roomSize.value;
      setStatus("Creating room…");
      lobby
        .createRoom(roomName.value, isArenaSize(size) ? ARENAS[size] : undefined)
        .then((room) => {
          roomName.value = "";
          setStatus(`Created ${room.name}`);
        })
        .catch((error: unknown) => setStatus(`Could not create room: ${errorMessage(error)}`, "error"));
    },
    { signal },
  );

  return {
    showError: (message) => setStatus(message, "error"),
    hide() {
      root.hidden = true;
    },
    show() {
      root.hidden = false;
    },
    dispose() {
      controller.abort();
    },
  };
}
