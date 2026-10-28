import { z } from "zod";
import { type Arena, ArenaSchema, check } from "@dogfight/shared/protocol.ts";

// The slice of fetch() this module uses, so tests can pass a small fake
// instead of a full Response.
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface RequestInitLike {
  signal?: AbortSignal | undefined;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
export type FetchLike = (url: string, init?: RequestInitLike) => Promise<ResponseLike>;

// An error that knows whether trying again could help.
export class LoadError extends Error {
  retryable: boolean;
  constructor(message: string, { retryable = true, cause }: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause });
    this.name = "LoadError";
    this.retryable = retryable;
  }
}

export class HttpError extends LoadError {
  readonly status: number;
  constructor(response: ResponseLike, url: string) {
    super(`Request failed: ${response.status} ${response.statusText} (${url})`, { retryable: response.status >= 500 });
    this.name = "HttpError";
    this.status = response.status;
  }
}

const ManifestSchema = z.object({
  spritesheet: z.object({ url: z.string() }).optional(),
  frames: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
  sounds: z.record(z.string(), z.object({ url: z.string(), required: z.boolean().optional() })).optional(),
  arena: z.string().optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export type Frame = readonly [number, number, number, number];

export interface Assets {
  spritesheet: HTMLImageElement | null;
  frames: Readonly<Record<string, Frame>>;
  sounds: Record<string, AudioBuffer>;
  arena: Arena | null;
  errors: { key: string; error: unknown }[];
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

// Several required assets failed; retryable if any of them could succeed later.
export class RequiredAssetsError extends AggregateError {
  readonly retryable: boolean;
  constructor(errors: unknown[], message: string, retryable: boolean) {
    super(errors, message);
    this.name = "RequiredAssetsError";
    this.retryable = retryable;
  }
}

const isNonRetryable = (error: unknown) =>
  (error instanceof LoadError || error instanceof RequiredAssetsError) && !error.retryable;
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  { attempts = 3, baseMs = 200, signal }: { attempts?: number; baseMs?: number; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await operation(signal);
    } catch (error: unknown) {
      if (attempt >= attempts || signal?.aborted || isAbort(error) || isNonRetryable(error))
        throw signal?.aborted ? abortError(signal) : error;
      const backoff = baseMs * 2 ** (attempt - 1);
      await delay(backoff * (0.5 + Math.random()), signal);
    }
  }
}

export async function fetchJson(
  url: string,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal | undefined; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new LoadError(`Invalid JSON response from ${url}`, { retryable: false, cause: error });
  }
}

export function decodeImage(blob: Blob, signal: AbortSignal | undefined): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(objectUrl);
    };
    const onAbort = () => {
      cleanup();
      image.src = "";
      reject(abortError(signal));
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new LoadError("Could not decode image data", { retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.src = objectUrl;
  });
}

export async function loadImage(
  url: string,
  {
    signal,
    fetchImpl = fetch,
    decode = decodeImage,
  }: { signal?: AbortSignal | undefined; fetchImpl?: FetchLike; decode?: typeof decodeImage } = {},
): Promise<HTMLImageElement> {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  const blob = await response.blob();
  throwIfAborted(signal);
  return decode(blob, signal);
}

export async function loadAudio(
  context: BaseAudioContext,
  url: string,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal | undefined; fetchImpl?: FetchLike } = {},
): Promise<AudioBuffer> {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  const data = await response.arrayBuffer();
  throwIfAborted(signal);
  try {
    const decoded = await context.decodeAudioData(data);
    throwIfAborted(signal);
    return decoded;
  } catch (error: unknown) {
    if (isAbort(error)) throw error;
    throw new LoadError(`Could not decode audio from ${url}`, { retryable: false, cause: error });
  }
}

// A job loads one resource and returns how to store it, so the result needs
// no type test afterwards.
interface Job {
  readonly key: string;
  readonly required: boolean;
  run(signal: AbortSignal | undefined): Promise<(assets: Assets) => void>;
}

type Outcome = { job: Job; ok: true; store: (assets: Assets) => void } | { job: Job; ok: false; error: unknown };

export interface LoadAllOptions {
  onProgress?: (ratio: number, completed: number, total: number) => void;
  onWarning?: (key: string, error: unknown) => void;
  signal?: AbortSignal | undefined;
  audioContext?: BaseAudioContext | null | undefined;
  fetchImpl?: FetchLike;
}

export async function loadAll(
  manifestData: unknown,
  { onProgress = () => {}, onWarning = () => {}, signal, audioContext, fetchImpl = fetch }: LoadAllOptions = {},
): Promise<Assets> {
  const parsed = check(ManifestSchema, manifestData);
  if (!parsed.ok) throw new LoadError(`Invalid asset manifest: ${parsed.error.message}`, { retryable: false });
  const manifest = parsed.value;

  const jobs: Job[] = [];
  const { spritesheet, arena } = manifest;
  if (spritesheet)
    jobs.push({
      key: "spritesheet",
      required: true,
      run: async (s) => {
        const image = await loadImage(spritesheet.url, { signal: s, fetchImpl });
        return (assets) => (assets.spritesheet = image);
      },
    });
  if (arena)
    jobs.push({
      key: "arena",
      required: true,
      run: async (s) => {
        const value = check(ArenaSchema, await fetchJson(arena, { signal: s, fetchImpl }));
        if (!value.ok) throw new LoadError(`Invalid arena: ${value.error.message}`, { retryable: false });
        return (assets) => (assets.arena = value.value);
      },
    });
  for (const [key, sound] of Object.entries(manifest.sounds ?? {})) {
    jobs.push({
      key: `sound:${key}`,
      required: sound.required === true,
      run: async (s) => {
        if (!audioContext) throw new LoadError(`Web Audio is unavailable; cannot load ${sound.url}`, { retryable: false });
        const buffer = await loadAudio(audioContext, sound.url, { signal: s, fetchImpl });
        return (assets) => (assets.sounds[key] = buffer);
      },
    });
  }
  if (jobs.length === 0) throw new LoadError("The asset manifest contains no resources", { retryable: false });

  let completed = 0;
  onProgress(0, 0, jobs.length);
  const results = await Promise.all(
    jobs.map(async (job): Promise<Outcome> => {
      try {
        const store = await withRetry((s) => job.run(s), { signal });
        return { job, ok: true, store };
      } catch (error: unknown) {
        return { job, ok: false, error };
      } finally {
        completed++;
        onProgress(completed / jobs.length, completed, jobs.length);
      }
    }),
  );

  if (signal?.aborted) throw abortError(signal);
  const requiredFailures = results.flatMap((result) => (!result.ok && result.job.required ? [result] : []));
  if (requiredFailures.length > 0) {
    throw new RequiredAssetsError(
      requiredFailures.map((failure) => failure.error),
      `Required assets failed: ${requiredFailures.map(({ job }) => job.key).join(", ")}`,
      requiredFailures.some((failure) => !isNonRetryable(failure.error)),
    );
  }

  const assets: Assets = { spritesheet: null, frames: manifest.frames ?? {}, sounds: {}, arena: null, errors: [] };
  for (const result of results) {
    if (result.ok) {
      result.store(assets);
    } else {
      assets.errors.push({ key: result.job.key, error: result.error });
      onWarning(result.job.key, result.error);
    }
  }
  return assets;
}
