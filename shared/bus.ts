// A typed event bus: the event name decides the payload type, so
// `bus.emit("hit", { target })` is checked against the declared shape and a
// listener gets a typed payload instead of an untyped CustomEvent.detail.
export type Listener<T> = (payload: T) => void;

export class Bus<E extends Record<string, unknown>> {
  #listeners: { [K in keyof E]?: Set<Listener<E[K]>> } = {};

  on<K extends keyof E>(name: K, listener: Listener<E[K]>): () => void {
    const listeners = this.#listeners[name] ?? new Set<Listener<E[K]>>();
    listeners.add(listener);
    this.#listeners[name] = listeners;
    return () => {
      listeners.delete(listener);
    };
  }

  once<K extends keyof E>(name: K, listener: Listener<E[K]>): () => void {
    const off = this.on(name, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const listeners = this.#listeners[name];
    if (!listeners) return;
    for (const listener of [...listeners]) listener(payload);
  }

  clear(): void {
    this.#listeners = {};
  }
}
