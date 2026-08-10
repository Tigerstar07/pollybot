import { startTransition, useEffect, useMemo, useState } from "react";
import type { DashboardData } from "../dashboardTypes";
import {
  DecisionInspector,
  DecisionTable,
  CalibrationPanel,
  Header,
  PaperLedger,
  ReadinessPanel,
  RunHistory,
  SettlementPanel,
  SummaryRail,
  type DecisionFilter,
  type InspectorTab,
} from "./components";
import { fetchDashboard, runScan, settleMarkets, simulatePaperOrder } from "./api";
import "./styles.css";

export default function App() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [settling, setSettling] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [filter, setFilter] = useState<DecisionFilter>("ALL");
  const [category, setCategory] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<InspectorTab>("WHY");
  const [orderMessage, setOrderMessage] = useState<{ kind: "error" | "success"; text: string }>();

  async function refresh() {
    try {
      const next = await fetchDashboard();
      startTransition(() => {
        setData(next);
        setError(undefined);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, []);

  const filteredDecisions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matched = (data?.decisions ?? []).filter((decision) => {
      const matchesFilter =
        filter === "ALL" ||
        (filter === "CANDIDATE" && (decision.action === "PAPER_BET" || decision.action === "LIVE_BET")) ||
        decision.action === filter;
      const matchesCategory = category === "ALL" || decision.category === category;
      return matchesFilter && matchesCategory && (!normalizedQuery || `${decision.title} ${decision.category}`.toLowerCase().includes(normalizedQuery));
    });
    return category === "ALL" && filter === "ALL" ? diversifyByCategory(matched) : matched;
  }, [category, data?.decisions, filter, query]);

  const categories = useMemo(
    () => [...new Set((data?.decisions ?? []).map((decision) => decision.category))].sort(),
    [data?.decisions],
  );

  const selected =
    data?.decisions.find((decision) => decision.marketId === selectedId) ??
    filteredDecisions[0] ??
    data?.decisions[0];
  const counts = useMemo(() => {
    const next: Record<DecisionFilter, number> = { ALL: 0, CANDIDATE: 0, WATCH: 0, UNMODELED: 0, SKIP: 0 };
    for (const decision of data?.decisions ?? []) {
      next.ALL += 1;
      if (decision.action === "PAPER_BET" || decision.action === "LIVE_BET") next.CANDIDATE += 1;
      else if (decision.action === "WATCH") next.WATCH += 1;
      else if (decision.action === "UNMODELED") next.UNMODELED += 1;
      else if (decision.action === "SKIP") next.SKIP += 1;
    }
    return next;
  }, [data?.decisions]);

  async function handleRunScan() {
    setRunning(true);
    setError(undefined);
    setOrderMessage(undefined);
    try {
      await runScan();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refresh();
    } finally {
      setRunning(false);
    }
  }

  async function handleSimulate() {
    if (!selected) return;
    setOrdering(true);
    setOrderMessage(undefined);
    try {
      await simulatePaperOrder(selected.marketId);
      setOrderMessage({ kind: "success", text: "Paper order recorded after fresh quote and risk checks." });
      await refresh();
    } catch (caught) {
      setOrderMessage({ kind: "error", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setOrdering(false);
    }
  }

  async function handleSettle() {
    setSettling(true);
    setError(undefined);
    try {
      await settleMarkets();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettling(false);
    }
  }

  const lastCompletedRun = data?.runs.find((run) => run.status === "ok" && run.finishedAt);
  const activeRunning = running || Boolean(data?.scan.running);
  const summary = data?.summary ?? {
    marketsScanned: 0,
    candidates: 0,
    watched: 0,
    unmodeled: 0,
    skipped: 0,
    openExposureEur: 0,
    maxOpenExposureEur: 1,
    bankrollEur: 10,
    liveOrders: 0,
    maxBetEur: 0.2,
  };

  return (
    <div className="app-shell" id="top">
      <Header
        running={activeRunning}
        settling={settling}
        lastScan={lastCompletedRun?.finishedAt}
        liveEnabled={Boolean(data?.safety.liveExecutionEnabled)}
        onRunScan={handleRunScan}
        onSettle={handleSettle}
      />
      <main>
        <SummaryRail
          markets={summary.marketsScanned}
          candidates={summary.candidates}
          exposure={summary.openExposureEur}
          maxExposure={summary.maxOpenExposureEur}
          liveOrders={summary.liveOrders}
          sportsOddsConfigured={Boolean(data?.safety.sportsOddsConfigured)}
          sportsOddsRemaining={data?.sourceHealth.sportsOdds.requestsRemaining}
          liveReady={Boolean(data?.liveReadiness.ready)}
          liveEnabled={Boolean(data?.safety.liveExecutionEnabled)}
        />
        <div className="page-heading">
          <div><h1>Decision room</h1><p>Inspect evidence, uncertainty, executable prices, and every refusal before trusting the bot.</p></div>
          <div className="data-stamp"><span className={activeRunning ? "pulse" : ""} />{activeRunning ? "Scan in progress" : `Data as of ${data ? new Date(data.generatedAt).toLocaleTimeString() : "—"}`}</div>
        </div>
        {error ? <div className="global-error" role="alert">{error}</div> : null}
        <div className="decision-layout">
          <DecisionTable
            decisions={filteredDecisions}
            selectedId={selected?.marketId}
            filter={filter}
            query={query}
            category={category}
            categories={categories}
            counts={counts}
            onFilter={setFilter}
            onQuery={setQuery}
            onCategory={setCategory}
            onSelect={(id) => {
              setSelectedId(id);
              setTab("WHY");
              setOrderMessage(undefined);
            }}
          />
          <DecisionInspector
            decision={selected}
            tab={tab}
            busy={ordering}
            maxBetEur={summary.maxBetEur}
            message={orderMessage}
            onTab={setTab}
            onSimulate={handleSimulate}
          />
        </div>
        {data ? (
          <div className="lower-grid readiness-grid">
            <CalibrationPanel calibration={data.calibration} />
            <ReadinessPanel readiness={data.liveReadiness} sportsOdds={data.sourceHealth.sportsOdds} />
          </div>
        ) : null}
        <div className="lower-grid">
          <PaperLedger orders={data?.paperOrders ?? []} exposure={summary.openExposureEur} maxExposure={summary.maxOpenExposureEur} />
          <SettlementPanel settlements={data?.recentSettlements ?? []} />
        </div>
        <div className="single-panel"><RunHistory runs={data?.runs ?? []} /></div>
      </main>
      <footer>
        <span><i /> {data?.safety.mode === "live" ? "Live mode" : "Paper mode"}</span>
        <span>
          Local evaluator · {data?.safety.liveExecutionEnabled ? "Live execution explicitly enabled" : "Live execution disabled"}
        </span>
      </footer>
    </div>
  );
}

function diversifyByCategory<T extends { category: string }>(items: T[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const bucket = buckets.get(item.category) ?? [];
    bucket.push(item);
    buckets.set(item.category, bucket);
  }
  const result: T[] = [];
  let index = 0;
  while (result.length < items.length) {
    let added = false;
    for (const bucket of buckets.values()) {
      const item = bucket[index];
      if (item) {
        result.push(item);
        added = true;
      }
    }
    if (!added) break;
    index += 1;
  }
  return result;
}
