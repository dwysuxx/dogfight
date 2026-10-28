// Typed element lookup without casts: `instanceof` narrows the result, and a
// missing or wrong element fails loudly at startup instead of as `null` later.
type ElementClass<T extends Element> = abstract new (...args: never[]) => T;

export function byId<T extends HTMLElement>(id: string, type: ElementClass<T>): T {
  return query(document, `#${id}`, type);
}

export function query<T extends Element>(root: ParentNode, selector: string, type: ElementClass<T>): T {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new TypeError(`Expected ${selector} to be a ${type.name}`);
  return found;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map((item: unknown) => errorMessage(item)).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

// localStorage can be missing or throw (private mode, blocked storage).
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A preference that is not remembered is fine.
    }
  },
};
