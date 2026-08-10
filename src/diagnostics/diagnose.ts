import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import { promisify } from "node:util";
import type { AppConfig } from "../config";
import { fetchText } from "../providers/polymarket/client";
import { checkGeoblock } from "../providers/polymarket/geoblock";

const execFileAsync = promisify(execFile);

interface DnsResult {
  domain: string;
  ok: boolean;
  addresses: string[];
  error?: string;
}

interface HttpResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string | null;
  error?: string;
  code?: string;
  sample?: string;
}

export async function runDiagnostics(config: AppConfig): Promise<void> {
  console.log("Polymarket access diagnostics");
  console.log("");

  const domains = [
    new URL(config.polymarketFrontendUrl).hostname,
    new URL(config.polymarketGammaUrl).hostname,
    new URL(config.polymarketClobUrl).hostname,
    "docs.polymarket.com",
  ];
  const dnsResults = await Promise.all(domains.map(checkDns));
  printDns(dnsResults);

  const httpResults = await Promise.all([
    checkHttp("Frontend", config.polymarketFrontendUrl),
    checkHttp("Geoblock", new URL("/api/geoblock", config.polymarketFrontendUrl).toString()),
    checkHttp("Gamma status", new URL("/status", config.polymarketGammaUrl).toString()),
    checkHttp("CLOB ok", new URL("/", config.polymarketClobUrl).toString()),
    checkHttp("CLOB time", new URL("/time", config.polymarketClobUrl).toString()),
  ]);
  printHttp(httpResults);

  const geo = await checkGeoblock(config);
  console.log("");
  console.log("Geoblock:");
  if (geo.ok) {
    console.log(`  status: ${geo.status}`);
    console.log(`  blocked: ${geo.blocked}`);
    console.log(`  country: ${geo.country ?? "unknown"}`);
    console.log(`  region: ${geo.region ?? "unknown"}`);
    console.log(`  resolver: ${geo.resolver ?? "system"}`);
    if (geo.blocked) {
      console.log("  result: STOP. Polymarket reports this location is blocked for order placement.");
    } else {
      console.log("  result: geoblock endpoint says order placement is not blocked from this IP.");
    }
  } else {
    console.log(`  result: could not verify geoblock (${geo.errorCode ?? "no-code"} ${geo.error ?? ""})`);
    console.log("  live trading policy: STOP. The bot refuses live orders when geoblock cannot be verified.");
  }

  const psResult = await checkPowerShellGeoblock(config);
  console.log("");
  console.log("PowerShell geoblock probe:");
  console.log(`  ${psResult}`);

  console.log("");
  console.log("Likely cause:");
  console.log(`  ${classify(dnsResults, httpResults, geo.ok, Boolean(geo.blocked))}`);
}

async function checkDns(domain: string): Promise<DnsResult> {
  try {
    const lookup = await dns.lookup(domain, { all: true });
    return {
      domain,
      ok: lookup.length > 0,
      addresses: lookup.map((entry) => `${entry.address}/${entry.family}`),
    };
  } catch (error) {
    return {
      domain,
      ok: false,
      addresses: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkHttp(name: string, url: string): Promise<HttpResult> {
  try {
    const result = await fetchText(url, 20_000);
    return {
      name,
      url,
      ok: result.status >= 200 && result.status < 400,
      status: result.status,
      contentType: result.headers.get("content-type"),
      sample: result.text.slice(0, 120).replace(/\s+/g, " "),
    };
  } catch (error) {
    const record = error as { message?: string; code?: string };
    return {
      name,
      url,
      ok: false,
      error: record.message ?? String(error),
      code: record.code,
    };
  }
}

async function checkPowerShellGeoblock(config: AppConfig): Promise<string> {
  if (process.platform !== "win32") return "skipped: not running on Windows";
  const url = new URL("/api/geoblock", config.polymarketFrontendUrl).toString();
  const command = [
    "$ProgressPreference='SilentlyContinue';",
    "try {",
    `$r = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 20;`,
    "$body = $r.Content;",
    "if ($body.Length -gt 300) { $body = $body.Substring(0,300) };",
    "Write-Output (\"OK status=\" + $r.StatusCode + \" body=\" + $body)",
    "} catch {",
    "Write-Output (\"ERROR \" + $_.Exception.Message)",
    "}",
  ].join(" ");
  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 30_000 });
    return (stdout || stderr).trim().replace(/\s+/g, " ");
  } catch (error) {
    return `ERROR ${error instanceof Error ? error.message : String(error)}`;
  }
}

function printDns(results: DnsResult[]): void {
  console.log("DNS:");
  for (const result of results) {
    console.log(`  ${result.domain}: ${result.ok ? result.addresses.join(", ") : `FAILED ${result.error ?? ""}`}`);
  }
}

function printHttp(results: HttpResult[]): void {
  console.log("");
  console.log("HTTP/TLS:");
  for (const result of results) {
    if (result.ok) {
      console.log(`  ${result.name}: HTTP ${result.status} ${result.contentType ?? ""} ${result.sample ?? ""}`);
    } else {
      console.log(`  ${result.name}: FAILED ${result.code ?? ""} ${result.error ?? ""}`);
    }
  }
}

function classify(dnsResults: DnsResult[], httpResults: HttpResult[], geoblockVerified: boolean, blocked: boolean): string {
  if (blocked) return "Actual Polymarket geoblock. Do not trade or bypass restrictions.";
  if (dnsResults.some((result) => !result.ok)) return "DNS resolution failure for at least one official Polymarket domain.";
  const frontend = httpResults.find((result) => result.name === "Frontend");
  const geoblock = httpResults.find((result) => result.name === "Geoblock");
  const gamma = httpResults.find((result) => result.name === "Gamma status");
  const clob = httpResults.find((result) => result.name === "CLOB ok");
  if (!frontend?.ok && !geoblock?.ok && gamma?.ok && clob?.ok) {
    return geoblockVerified
      ? "The router/system DNS path blocks the frontend, but the official geoblock endpoint was verified through the configured public-DNS fallback. Chrome should use secure DNS."
      : "Frontend/geoblock path is unreachable while Gamma and CLOB are reachable. This points to network/ISP/firewall/frontdoor blocking, not a scanner API outage. Live trading remains refused because geoblock cannot be verified.";
  }
  if (!gamma?.ok || !clob?.ok) return "Core API connectivity issue. Check firewall, ISP, captive portal, or hotspot routing.";
  if (!geoblockVerified) return "Market APIs are reachable, but geoblock could not be verified. Treat live trading as unavailable.";
  return "No obvious network block detected by these probes.";
}
