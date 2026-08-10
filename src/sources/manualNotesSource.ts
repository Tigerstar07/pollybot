import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config";
import type { NormalizedMarket, SourceObservation } from "../types";
import { nowIso } from "../utils";

export function readManualNotes(config: AppConfig, market: NormalizedMarket): SourceObservation {
  const notesPath = path.join(config.projectRoot, "data", "manual-notes.json");
  if (!fs.existsSync(notesPath)) {
    return {
      sourceType: "manual-notes",
      sourceKey: `manual:${market.marketId}`,
      collectedAt: nowIso(),
      payload: {},
      available: false,
      reason: "data/manual-notes.json not found",
    };
  }

  try {
    const notes = JSON.parse(fs.readFileSync(notesPath, "utf8")) as Record<string, unknown>;
    const note = notes[market.marketId] ?? notes[market.slug ?? ""];
    return {
      sourceType: "manual-notes",
      sourceKey: `manual:${market.marketId}`,
      collectedAt: nowIso(),
      payload: note && typeof note === "object" ? (note as Record<string, unknown>) : { note },
      available: Boolean(note),
      independent: true,
      quality: note && typeof note === "object" ? 0.7 : 0,
      reason: note ? undefined : "No manual note for this market",
    };
  } catch (error) {
    return {
      sourceType: "manual-notes",
      sourceKey: `manual:${market.marketId}`,
      collectedAt: nowIso(),
      payload: {},
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
