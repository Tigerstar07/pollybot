import { logger } from "../logger";
import { loadConfig } from "../config";

export interface ResilientFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resilientFetch(url: string | URL, options?: ResilientFetchOptions): Promise<Response> {
  const config = loadConfig();
  const maxRetries = options?.maxRetries ?? config.networkMaxRetries;
  const baseDelay = options?.baseDelayMs ?? 1000;
  const maxDelay = options?.maxDelayMs ?? 10000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || new DOMException("The user aborted a request.", "AbortError");
    }

    const attemptController = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    let timeoutReject: ((reason?: unknown) => void) | undefined;

    const onUserAbort = () => {
      attemptController.abort(options?.signal?.reason);
    };

    if (options?.signal) {
      options.signal.addEventListener("abort", onUserAbort);
    }

    const timeoutMs = options?.timeoutMs ?? config.networkTimeoutMs;
    let timeoutPromise: Promise<never> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timeoutPromise = new Promise((_, reject) => {
        timeoutReject = reject;
        timeoutId = setTimeout(() => {
          const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
          attemptController.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
    }

    try {
      const fetchOptions: RequestInit = {
        ...options,
        signal: attemptController.signal,
      };
      // Delete custom options
      delete (fetchOptions as any).timeoutMs;
      delete (fetchOptions as any).maxRetries;
      delete (fetchOptions as any).baseDelayMs;
      delete (fetchOptions as any).maxDelayMs;

      const fetchPromise = fetch(url, fetchOptions);
      const response = await (timeoutPromise ? Promise.race([fetchPromise, timeoutPromise]) : fetchPromise);

      // Check if response is transient failure (HTTP 429 or 5xx)
      if (response.status >= 500 || response.status === 429) {
        if (attempt < maxRetries) {
          throw new Error(`HTTP ${response.status}`);
        }
      }

      // Success or final attempt transient error
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.signal) options.signal.removeEventListener("abort", onUserAbort);

      return response;
    } catch (error: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.signal) options.signal.removeEventListener("abort", onUserAbort);

      if (options?.signal?.aborted) {
        throw error; // User abort propagated
      }

      const isTimeout = error instanceof Error && (
        error.name === "TimeoutError" ||
        error.message.includes("timeout") ||
        error.message.includes("Timeout")
      );

      const isNetworkError = error instanceof TypeError || (
        error instanceof Error && (
          error.message.includes("fetch failed") ||
          error.message.includes("network") ||
          (error as any).code === "ENOTFOUND" ||
          (error as any).code === "ECONNREFUSED" ||
          (error as any).code === "ECONNRESET"
        )
      );

      const isTransientStatus = error instanceof Error && (
        error.message.startsWith("HTTP 5") || error.message.startsWith("HTTP 429")
      );

      const shouldRetry = isTimeout || isNetworkError || isTransientStatus;

      if (!shouldRetry || attempt === maxRetries) {
        throw error;
      }

      // Log retry
      logger.warn(`Network request to ${url.toString()} failed: ${error.message}. Retrying in attempt ${attempt + 1}/${maxRetries}...`);

      // Exponential backoff with randomized Full Jitter
      const temp = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      const delay = Math.random() * temp;
      await sleep(delay);
    } finally {
      timeoutReject = undefined;
    }
  }

  throw new Error("Resilient fetch failed unexpectedly");
}

export async function resilientFetchText(
  url: string | URL,
  options?: ResilientFetchOptions,
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await resilientFetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    text,
    headers: response.headers,
  };
}

export async function resilientFetchJson<T>(
  url: string | URL,
  options?: ResilientFetchOptions,
): Promise<{ status: number; data: T; headers: Headers }> {
  const result = await resilientFetchText(url, options);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status}`);
  }
  try {
    const data = JSON.parse(result.text) as T;
    return {
      status: result.status,
      data,
      headers: result.headers,
    };
  } catch (error) {
    throw new Error(`JSON parse error for HTTP ${result.status}`);
  }
}
