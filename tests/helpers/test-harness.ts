import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mockFetch } from "./mock-router";
import { openDatabase, type Db } from "../../src/db";
import { loadConfig } from "../../src/config";

export interface Harness {
  testDbPath: string;
  tempDir: string;
  db: Db;
  cleanup: () => void;
  runCommand: (command: string, envOverrides?: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
}

export function createTestHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pollybot-test-"));
  const testDbPath = path.resolve(tempDir, "test.sqlite");

  const originalDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = testDbPath;

  const db = openDatabase(loadConfig());

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = mockFetch;

  const cleanup = () => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    if (originalDbPath !== undefined) {
      process.env.DATABASE_PATH = originalDbPath;
    } else {
      delete process.env.DATABASE_PATH;
    }
    (globalThis as any).fetch = originalFetch;
  };

  const runCommand = (command: string, envOverrides: Record<string, string> = {}) => {
    const preloadPath = path.resolve(process.cwd(), "tests/helpers/preload-mock.ts");
    const indexPath = path.resolve(process.cwd(), "src/index.ts");
    const preloadUrl = pathToFileURL(preloadPath).href;

    const result = spawnSync("npx", [
      "tsx",
      "--import",
      preloadUrl,
      indexPath,
      command
    ], {
      env: {
        ...process.env,
        DATABASE_PATH: testDbPath,
        DRY_RUN: "true",
        ENABLE_REAL_TRADING: "false",
        BANKROLL_EUR: "20",
        ENABLE_LLM_REASONING: "false",
        MIN_EDGE: "0.03",
        MIN_CONFIDENCE: "0.45",
        MIN_INDEPENDENT_SOURCES: "1",
        MIN_HOURS_TO_END: "2",
        MAX_DAYS_TO_END: "365",
        LIVE_MIN_HOURS_TO_END: "2",
        LIVE_MAX_HOURS_TO_END: `${365 * 24}`,
        ...envOverrides
      },
      shell: true,
      encoding: "utf8"
    });

    if (result.status !== 0) {
      console.error(`runCommand failed for command "${command}":`, result.stderr);
    }

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  return {
    testDbPath,
    tempDir,
    db,
    cleanup,
    runCommand
  };
}

import type { NormalizedMarket, ProbabilityEstimate } from "../../src/types";
import type { SettledBetRow } from "../../src/db";

export function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: "polymarket",
    marketId: "market-test",
    title: "Will the objectively measured value exceed the threshold by the stated date?",
    category: "objective-event",
    outcomes: ["Yes", "No"],
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesPrice: 0.5,
    noPrice: 0.5,
    bestBid: 0.48,
    bestAsk: 0.5,
    noBestBid: 0.48,
    noBestAsk: 0.5,
    spread: 0.02,
    noSpread: 0.02,
    liquidity: 10_000,
    volume: 100_000,
    endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    status: "open",
    resolutionSource: "Official published dataset",
    rules:
      "This market will resolve to Yes according to the official published dataset if the precisely defined value is greater than the threshold before the stated deadline. Otherwise it resolves No.",
    tags: [],
    raw: {},
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeEstimate(overrides: Partial<ProbabilityEstimate> = {}): ProbabilityEstimate {
  return {
    marketId: "market-test",
    estimatedYesProbability: 0.75,
    estimatedNoProbability: 0.25,
    confidence: 0.75,
    method: "test-independent-model",
    reasoningSummary: "Deterministic test estimate",
    keyEvidence: ["Fixture evidence"],
    risks: ["Fixture uncertainty"],
    independentEvidenceCount: 1,
    dataQuality: 0.8,
    modelUncertainty: 0.08,
    shouldSkip: false,
    ...overrides,
  };
}

export function settledBet(overrides: Partial<SettledBetRow>): SettledBetRow {
  return {
    market_id: "m",
    outcome: "YES",
    price: 0.6,
    confidence: 0.6,
    edge: 0.12,
    forecast_prob: 0.7,
    market_prior_prob: 0.6,
    size_eur: 0.3,
    pnl_eur: 0.1,
    closed_at: new Date().toISOString(),
    ...overrides,
  };
}
