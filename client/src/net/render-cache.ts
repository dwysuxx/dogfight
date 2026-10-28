// One drawable entity per id, updated in place every frame. Before Lab 7 the
// renderer built a fresh Ship/Bullet/Asteroid/Explosion (with its Map, arrays
// and, for explosions, every particle) for every entity on every frame: the
// biggest source of per-frame garbage after the iterators.
import type { EntityId } from "@dogfight/shared/brand.ts";
import { type EntitySnapshot, assertNever } from "@dogfight/shared/protocol.ts";
import type { PlayerLookup } from "@dogfight/shared/sim/ship.ts";
import { entityFromSnapshot } from "@dogfight/shared/sim/snapshot.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { GameEntity } from "@dogfight/shared/sim/world.ts";
import type { Pose } from "../snapshot-buffer.ts";

function apply(entity: GameEntity, data: EntitySnapshot, players: PlayerLookup): boolean {
  switch (data.kind) {
    case "ship":
      if (entity.kind !== "ship") return false;
      entity.applySnapshot(data, { players });
      return true;
    case "bullet":
      if (entity.kind !== "bullet") return false;
      entity.applySnapshot(data);
      return true;
    case "asteroid":
      if (entity.kind !== "asteroid") return false;
      entity.applySnapshot(data);
      return true;
    case "pickup":
      if (entity.kind !== "pickup") return false;
      entity.applySnapshot(data);
      return true;
    case "explosion":
      if (entity.kind !== "explosion") return false;
      entity.applySnapshot(data);
      return true;
    default:
      return assertNever(data, "entity kind");
  }
}

export class RenderCache {
  #entries = new Map<EntityId, { entity: GameEntity; frame: number }>();
  #frame = 0;

  get size(): number {
    return this.#entries.size;
  }

  begin(): void {
    this.#frame++;
  }

  // The cached entity for this data (created on first sight), updated and
  // placed at `pose`.
  place(data: EntitySnapshot, pose: Pose, players: PlayerLookup): GameEntity {
    let entry = this.#entries.get(data.id);
    if (!entry || !apply(entry.entity, data, players)) {
      entry = { entity: entityFromSnapshot(data, { players }), frame: 0 };
      this.#entries.set(data.id, entry);
    }
    entry.frame = this.#frame;
    const entity = entry.entity;
    if (entity.pos.x !== pose.x || entity.pos.y !== pose.y) entity.pos = new Vector2(pose.x, pose.y);
    entity.prevPos = entity.pos; // already interpolated: drawn at alpha 1
    entity.angle = entity.prevAngle = pose.angle;
    if (entity.kind === "explosion") entity.age = pose.age;
    return entity;
  }

  get(id: EntityId): GameEntity | undefined {
    return this.#entries.get(id)?.entity;
  }

  // Forget whatever was not drawn this frame (despawned entities).
  end(): void {
    this.#entries.forEach(this.#evict, this);
  }

  #evict(this: RenderCache, entry: { frame: number }, id: EntityId, entries: Map<EntityId, unknown>): void {
    if (entry.frame !== this.#frame) entries.delete(id);
  }
}
