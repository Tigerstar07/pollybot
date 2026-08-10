import type { DashboardData } from "../dashboardTypes";

export async function fetchDashboard(): Promise<DashboardData> {
  return request<DashboardData>("/api/dashboard");
}

export async function runScan(): Promise<void> {
  await request("/api/scan", { method: "POST" });
}

export async function settleMarkets(): Promise<void> {
  await request("/api/settle", { method: "POST" });
}

export async function simulatePaperOrder(marketId: string): Promise<void> {
  await request("/api/paper-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId }),
  });
}

async function request<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T & { error?: string; blockers?: string[] };
  if (!response.ok) {
    const blockers = payload.blockers?.length ? ` ${payload.blockers.join("; ")}` : "";
    throw new Error(`${payload.error ?? `HTTP ${response.status}`}${blockers}`);
  }
  return payload;
}
