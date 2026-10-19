export class HttpError extends Error {
  constructor(response, url) {
    super(`Request failed: ${response.status} ${response.statusText} (${url})`);
    this.name = "HttpError";
    this.status = response.status;
    this.retryable = response.status >= 500;
  }
}

function abortError(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function isNonRetryable(error) {
  return (
    error?.retryable === false ||
    (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)
  );
}

function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry(
  operation,
  { attempts = 3, baseMs = 200, signal } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new RangeError("attempts must be a positive integer");

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await operation(signal);
    } catch (error) {
      if (
        attempt >= attempts ||
        signal?.aborted ||
        error?.name === "AbortError" ||
        isNonRetryable(error)
      ) {
        throw signal?.aborted ? abortError(signal) : error;
      }
      const backoff = baseMs * 2 ** (attempt - 1);
      await delay(backoff * (0.5 + Math.random()), signal);
    }
  }
}

export async function fetchJson(url, { signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  try {
    return await response.json();
  } catch (error) {
    const invalidJson = new Error(`Invalid JSON response from ${url}`, { cause: error });
    invalidJson.retryable = false;
    throw invalidJson;
  }
}

export async function loadImage(
  url,
  { signal, ImageCtor = Image, fetchImpl = fetch } = {},
) {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    throwIfAborted(signal);
    return await new Promise((resolve, reject) => {
      const image = new ImageCtor();
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener("abort", onAbort);
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
        const error = new Error(`Could not decode image data from ${url}`);
        error.retryable = false;
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadAudio(context, url, { signal, fetchImpl = fetch } = {}) {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new HttpError(response, url);
  const data = await response.arrayBuffer();
  throwIfAborted(signal);
  try {
    const decoded = await context.decodeAudioData(data);
    throwIfAborted(signal);
    return decoded;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const invalidAudio = new Error(`Could not decode audio from ${url}`, { cause: error });
    invalidAudio.retryable = false;
    throw invalidAudio;
  }
}

export async function loadAll(
  manifest,
  {
    onProgress = () => {},
    onWarning = () => {},
    signal,
    audioContext,
    fetchImpl = fetch,
  } = {},
) {
  const jobs = [];
  if (manifest.spritesheet) {
    jobs.push({
      key: "spritesheet",
      required: true,
      run: (activeSignal) =>
        loadImage(manifest.spritesheet.url, { signal: activeSignal, fetchImpl }),
    });
  }
  if (manifest.arena) {
    jobs.push({
      key: "arena",
      required: true,
      run: (activeSignal) =>
        fetchJson(manifest.arena, { signal: activeSignal, fetchImpl }),
    });
  }
  for (const [key, sound] of Object.entries(manifest.sounds ?? {})) {
    jobs.push({
      key: `sound:${key}`,
      required: sound.required === true,
      run: (activeSignal) => {
        if (!audioContext) {
          const error = new Error(`Web Audio is unavailable; cannot load ${sound.url}`);
          error.retryable = false;
          throw error;
        }
        return loadAudio(audioContext, sound.url, { signal: activeSignal, fetchImpl });
      },
    });
  }

  if (jobs.length === 0) throw new Error("The asset manifest contains no resources");

  let completed = 0;
  onProgress(0, 0, jobs.length);
  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        const value = await withRetry(job.run, { signal });
        return { ...job, value };
      } catch (error) {
        return { ...job, error };
      } finally {
        completed++;
        onProgress(completed / jobs.length, completed, jobs.length);
      }
    }),
  );

  if (signal?.aborted) throw abortError(signal);
  const requiredFailures = results.filter((result) => result.required && result.error);
  if (requiredFailures.length > 0) {
    const error = new AggregateError(
      requiredFailures.map(({ error: failure }) => failure),
      `Required assets failed: ${requiredFailures.map(({ key }) => key).join(", ")}`,
    );
    error.retryable = requiredFailures.some(
      ({ error: failure }) => failure.retryable !== false,
    );
    throw error;
  }

  const assets = {
    spritesheet: null,
    frames: manifest.frames ?? {},
    sounds: {},
    arena: null,
    errors: [],
  };
  for (const result of results) {
    if (result.error) {
      assets.errors.push({ key: result.key, error: result.error });
      onWarning(result.key, result.error);
    } else if (result.key === "spritesheet" || result.key === "arena") {
      assets[result.key] = result.value;
    } else {
      assets.sounds[result.key.slice("sound:".length)] = result.value;
    }
  }
  return assets;
}
