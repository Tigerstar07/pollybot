import dns from "node:dns/promises";
import https from "node:https";
import type { AppConfig } from "../../config";
import { fetchJson, type HttpRequestError } from "./client";
import type { GeoblockResponse } from "./types";

export interface GeoblockCheck {
  ok: boolean;
  blocked?: boolean;
  country?: string;
  region?: string;
  ip?: string;
  status?: number;
  error?: string;
  errorCode?: string;
  resolver?: "system" | "public-dns-fallback";
}

export async function checkGeoblock(config: AppConfig): Promise<GeoblockCheck> {
  const url = new URL("/api/geoblock", config.polymarketFrontendUrl).toString();
  try {
    const result = await fetchJson<GeoblockResponse>(url, 10_000, 0);
    return {
      ok: true,
      status: result.status,
      blocked: Boolean(result.data.blocked),
      country: result.data.country,
      region: result.data.region,
      ip: result.data.ip,
      resolver: "system",
    };
  } catch (error) {
    const requestError = error as HttpRequestError;
    try {
      const result = await fetchGeoblockUsingPublicDns(url, 20_000);
      return {
        ok: true,
        status: result.status,
        blocked: Boolean(result.data.blocked),
        country: result.data.country,
        region: result.data.region,
        ip: result.data.ip,
        resolver: "public-dns-fallback",
      };
    } catch (fallbackError) {
      return {
        ok: false,
        status: requestError.status,
        error: `${requestError.message}; public DNS fallback failed: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
        errorCode: requestError.code,
      };
    }
  }
}

async function fetchGeoblockUsingPublicDns(
  urlString: string,
  timeoutMs: number,
): Promise<{ status: number; data: GeoblockResponse }> {
  const url = new URL(urlString);
  if (url.protocol !== "https:") throw new Error("geoblock fallback requires HTTPS");

  const resolver = new dns.Resolver();
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  const addresses = await resolver.resolve4(url.hostname);
  const address = addresses[0];
  if (!address) throw new Error(`public DNS returned no IPv4 address for ${url.hostname}`);

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "pollybot/1.0 compliance check" },
        lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) => {
          if (options?.all) {
            callback(null, [{ address, family: 4 }]);
          } else {
            callback(null, address, 4);
          }
        }) as any,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve({ status, data: JSON.parse(text) as GeoblockResponse });
          } catch {
            reject(new Error(`invalid JSON from geoblock endpoint (HTTP ${status})`));
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("geoblock fallback timed out")));
    request.on("error", reject);
    request.end();
  });
}
