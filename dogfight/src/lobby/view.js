export function createLobbyView(root, lobby, onJoin) {
  const controller = new AbortController();
  const signal = controller.signal;
  root.innerHTML = `
    <h1>Dogfight lobby</h1>
    <p id="lobby-status" role="status">Loading rooms…</p>
    <label>Pilot name <input id="pilot-name" maxlength="20" value="Pilot"></label>
    <form id="lobby-form">
      <fieldset>
        <legend>Available rooms</legend>
        <div id="room-list"></div>
      </fieldset>
      <button type="submit">Join selected room</button>
      <button type="button" id="refresh-rooms">Refresh</button>
    </form>`;

  const status = root.querySelector("#lobby-status");
  const roomList = root.querySelector("#room-list");

  function renderRooms(rooms) {
    const selectedId = roomList.querySelector('input[name="room"]:checked')?.value;
    roomList.replaceChildren();
    if (rooms.length === 0) {
      roomList.textContent = "No rooms are currently available.";
      return;
    }
    for (const [index, room] of rooms.entries()) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "room";
      radio.value = room.id;
      radio.required = true;
      radio.checked = room.id === selectedId || (!selectedId && index === 0);
      label.append(radio, ` ${room.name} — ${room.players}/${room.capacity} pilots`);
      roomList.append(label, document.createElement("br"));
    }
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  lobby.addEventListener("roomsChanged", (event) => renderRooms(event.detail), { signal });
  lobby.addEventListener(
    "refreshError",
    (event) => {
      status.textContent = `Could not refresh rooms: ${event.detail.message}`;
    },
    { signal },
  );
  root.querySelector("#refresh-rooms").addEventListener(
    "click",
    () => {
      status.textContent = "Refreshing rooms…";
      void lobby.refresh().catch((error) => {
        status.textContent = `Could not refresh rooms: ${error.message}`;
      });
    },
    { signal },
  );
  root.querySelector("#lobby-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const roomId = new FormData(event.currentTarget).get("room");
      if (typeof roomId !== "string") return;
      try {
        const joined = lobby.join(roomId, root.querySelector("#pilot-name").value);
        status.textContent = `Joining ${joined.room.name}…`;
        Promise.resolve(onJoin(joined)).catch((error) => {
          status.textContent = `Could not join room: ${error.message}`;
        });
      } catch (error) {
        status.textContent = `Could not join room: ${error.message}`;
      }
    },
    { signal },
  );

  return {
    showError(message) {
      status.textContent = message;
    },
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
