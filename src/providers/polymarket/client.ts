import type { AppConfig } from "../../config";
import { resilientFetchText, resilientFetchJson } from "../../utils/fetch";

export class HttpRequestError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function fetchText(url: string, timeoutMs = 15_000): Promise<{ status: number; text: string; headers: Headers }> {
  try {
    return await resilientFetchText(url, {
      timeoutMs,
      headers: { "user-agent": "pollybot/0.1 safe research bot" },
    });
  } catch (error: any) {
    const cause = error instanceof Error && "cause" in error ? (error.cause as { code?: string } | undefined) : undefined;
    throw new HttpRequestError(error instanceof Error ? error.message : String(error), url, undefined, cause?.code);
  }
}

export async function fetchJson<T>(
  url: string,
  timeoutMs = 15_000,
  maxRetries?: number,
): Promise<{ status: number; data: T; headers: Headers }> {
  try {
    return await resilientFetchJson<T>(url, {
      timeoutMs,
      maxRetries,
      headers: { "user-agent": "pollybot/0.1 safe research bot" },
    });
  } catch (error: any) {
    const statusMatch = error.message.match(/HTTP (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    const message = error.message.includes("JSON parse error") ? "Response was not valid JSON" : error.message;
    throw new HttpRequestError(message, url, status);
  }
}

export function gammaUrl(config: AppConfig, route: string, params?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(route, config.polymarketGammaUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function clobUrl(config: AppConfig, route: string, params?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(route, config.polymarketClobUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}
