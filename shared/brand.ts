// Branded number types: zero runtime cost, but a Tick can no longer be passed
// where an EntityId is expected. The only way to make one is the guard below,
// which checks the range the binary protocol can carry, so there is no `as`.
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Brand<number, "EntityId">; // u16 on the wire
export type PlayerId = Brand<number, "PlayerId">; // u8; 0 = nobody / the bot
export type Tick = Brand<number, "Tick">; // u32
export type Seq = Brand<number, "Seq">; // u32 input sequence number

const isUint = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;

export const isEntityId = (n: number): n is EntityId => isUint(n, 0xffff);
export const isPlayerId = (n: number): n is PlayerId => isUint(n, 0xff);
export const isTick = (n: number): n is Tick => isUint(n, 0xffffffff);
export const isSeq = (n: number): n is Seq => isUint(n, 0xffffffff);

function make<T extends number>(guard: (n: number) => n is T, name: string) {
  return (n: number): T => {
    if (!guard(n)) throw new RangeError(`${n} is not a valid ${name}`);
    return n;
  };
}

export const entityId = make(isEntityId, "EntityId");
export const playerId = make(isPlayerId, "PlayerId");
export const tick = make(isTick, "Tick");
export const seq = make(isSeq, "Seq");

export const NO_PLAYER: PlayerId = playerId(0);
export const NO_SEQ: Seq = seq(0);
