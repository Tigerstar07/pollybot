import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { resilientFetch, resilientFetchJson, resilientFetchText } from "../src/utils/fetch";
import { scanAndRank } from "../src/scanner";

let originalFetch = globalThis.fetch;

function setupMockFetch(mockFn: typeof globalThis.fetch) {
  globalThis.fetch = mockFn;
}

function restoreMockFetch() {
  globalThis.fetch = originalFetch;
}

test("resilientFetch retries on mock transient HTTP errors and eventually succeeds", async () => {
  let callCount = 0;
  setupMockFetch(async (url, init) => {
    callCount++;
    if (callCount < 3) {
      return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
    }
    return new Response("Success", { status: 200, statusText: "OK" });
  });

  try {
    const res = await resilientFetch("http://localhost/test", {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Success");
    assert.equal(callCount, 3);
  } finally {
    restoreMockFetch();
  }
});

test("resilientFetch fails immediately on non-transient HTTP errors", async () => {
  let callCount = 0;
  setupMockFetch(async (url, init) => {
    callCount++;
    return new Response("Bad Request", { status: 400, statusText: "Bad Request" });
  });

  try {
    const res = await resilientFetch("http://localhost/test", {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "Bad Request");
    assert.equal(callCount, 1);
  } finally {
    restoreMockFetch();
  }
});

test("resilientFetch aborts on timeout", async () => {
  setupMockFetch(async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response("Success", { status: 200 });
  });

  try {
    await assert.rejects(
      async () => {
        await resilientFetch("http://localhost/test", {
          timeoutMs: 10,
          maxRetries: 0,
        });
      },
      (err: any) => {
        return err instanceof Error && (err.name === "TimeoutError" || err.message.includes("timeout"));
      }
    );
  } finally {
    restoreMockFetch();
  }
});

test("scanAndRank keeps processing when one market has an unavailable source", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pollybot-test-"));
  const startDate = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  const testConfig: AppConfig = {
    ...loadConfig(),
    databasePath: path.join(tempDir, "test.sqlite"),
    sportsOddsApiKey: "test-api-key",
    sportsOddsMaxCallsPerScan: 10,
    scanMaxEvents: 50,
    minHoursToEnd: 2,
    maxDaysToEnd: 365,
    liveMinHoursToEnd: 2,
    liveMaxHoursToEnd: 365 * 24,
    liveMinStakeEur: 0.05,
  };

  const db = openDatabase(testConfig);

  let callCount = 0;
  let firstRequestUrl = "";
  setupMockFetch(async (url, init) => {
    callCount++;
    if (callCount === 1) {
      firstRequestUrl = String(url);
      const mockEvents = [
        {
          id: "e1",
          title: "Event 1",
          volume: "1000",
          liquidityClob: "500",
          endDate,
          startDate,
          markets: [
            {
              id: "m1",
              question: "Will BTC reach 100k?",
              outcomes: JSON.stringify(["YES", "NO"]),
              outcomePrices: JSON.stringify(["0.6", "0.4"]),
              clobTokenIds: JSON.stringify(["1", "2"]),
              closed: false,
              active: true,
            },
            {
              id: "m2",
              question: "Will Celtics defeat Lakers? (sports)",
              outcomes: JSON.stringify(["YES", "NO"]),
              outcomePrices: JSON.stringify(["0.5", "0.5"]),
              clobTokenIds: JSON.stringify(["3", "4"]),
              closed: false,
              active: true,
            }
          ],
        }
      ];
      return new Response(JSON.stringify(mockEvents), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  try {
    const rankings = await scanAndRank(testConfig, db, { print: false });

    assert.ok(rankings.length >= 1);
    assert.match(firstRequestUrl, /[?&]order=volume24hr(?:&|$)/);
    assert.ok(rankings.some((r) => r.market.marketId === "m1"));
    assert.ok(rankings.some((r) => r.market.marketId === "m2"));

    const sportsSource = db
      .prepare("SELECT * FROM sources WHERE market_id = ? AND source_type = ?")
      .get("m2", "sports-odds") as any;
    assert.ok(sportsSource);
    assert.equal(sportsSource.available, 0);
  } finally {
    restoreMockFetch();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
