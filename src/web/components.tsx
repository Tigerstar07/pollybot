import type {
  DashboardData,
  DashboardDecision,
  DashboardPaperOrder,
  DashboardRun,
} from "../dashboardTypes";
import { CheckIcon, ExternalIcon, PlayIcon, RefreshIcon, SearchIcon, ShieldIcon } from "./icons";

type DecisionFilter = "ALL" | "CANDIDATE" | "WATCH" | "UNMODELED" | "SKIP";
type InspectorTab = "WHY" | "EVIDENCE" | "RISKS" | "COSTS" | "FORMULA";

export function Header({
  running,
  settling,
  lastScan,
  onRunScan,
  onSettle,
  liveEnabled,
}: {
  running: boolean;
  settling: boolean;
  lastScan?: string;
  liveEnabled: boolean;
  onRunScan: () => void;
  onSettle: () => void;
}) {
  return (
    <header className="app-header">
      <a className="wordmark" href="#top" aria-label="Pollybot home">POLLYBOT</a>
      <nav className="primary-nav" aria-label="Primary navigation">
        <a className="active" href="#top">Overview</a>
        <a href="#candidates">Candidates</a>
        <a href="#ledger">Paper ledger</a>
      </nav>
      <div className="header-actions">
        <span className="mode-lock">{liveEnabled ? "LIVE MODE" : "PAPER MODE"}</span>
        <button className="button secondary" type="button" onClick={onSettle} disabled={running || settling}>
          {settling ? <RefreshIcon className="spin" /> : <CheckIcon />}
          {settling ? "Settling…" : "Settle"}
        </button>
        <button className="button primary" type="button" onClick={onRunScan} disabled={running || settling}>
          {running ? <RefreshIcon className="spin" /> : <PlayIcon />}
          {running ? "Scanning…" : "Run scan"}
        </button>
        <span className="last-scan"><RefreshIcon /> {lastScan ? `Last scan ${relativeTime(lastScan)}` : "No fresh scan"}</span>
      </div>
    </header>
  );
}

export function SummaryRail({
  markets,
  candidates,
  exposure,
  maxExposure,
  liveOrders,
  sportsOddsConfigured,
  sportsOddsRemaining,
  liveReady,
  liveEnabled,
}: {
  markets: number;
  candidates: number;
  exposure: number;
  maxExposure: number;
  liveOrders: number;
  sportsOddsConfigured: boolean;
  sportsOddsRemaining?: number;
  liveReady: boolean;
  liveEnabled: boolean;
}) {
  const items = [
    ["Markets scanned", String(markets)],
    ["Candidates", String(candidates)],
    ["Open exposure", `${money(exposure)} / ${money(maxExposure)}`],
    ["Real orders", String(liveOrders)],
  ];
  return (
    <section className="summary-band" aria-label="Scan summary">
      <div className="summary-rail">
        {items.map(([label, value]) => (
          <div className="summary-item" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="safety-callout">
        <ShieldIcon />
        <div>
          <strong>{liveEnabled ? "Live execution enabled" : liveReady ? "Live gates passed" : "Live execution disabled"}</strong>
          <span>
            Sports odds {sportsOddsConfigured ? "configured" : "needs SPORTS_ODDS_API_KEY"}
            {sportsOddsRemaining !== undefined ? ` · ${sportsOddsRemaining} credits left` : ""}
            {" · "}{liveEnabled ? "Real-money execution is enabled." : "Paper simulation only."}
          </span>
        </div>
      </div>
    </section>
  );
}

export function DecisionTable({
  decisions,
  selectedId,
  filter,
  query,
  category,
  categories,
  counts,
  onFilter,
  onQuery,
  onCategory,
  onSelect,
}: {
  decisions: DashboardDecision[];
  selectedId?: string;
  filter: DecisionFilter;
  query: string;
  category: string;
  categories: string[];
  counts: Record<DecisionFilter, number>;
  onFilter: (filter: DecisionFilter) => void;
  onQuery: (query: string) => void;
  onCategory: (category: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="market-region" id="candidates">
      <div className="market-tools">
        <div className="filters" role="tablist" aria-label="Decision filter">
          {(["ALL", "CANDIDATE", "WATCH", "UNMODELED", "SKIP"] as const).map((item) => (
            <button
              className={filter === item ? "active" : ""}
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              onClick={() => onFilter(item)}
            >
              {titleCase(item)} <span>{counts[item]}</span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <span className="sr-only">Search markets</span>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search markets…" />
          <SearchIcon />
        </label>
      </div>
      <div className="category-filters" aria-label="Market category">
        {["ALL", ...categories].map((item) => (
          <button
            type="button"
            className={category === item ? "active" : ""}
            aria-pressed={category === item}
            key={item}
            onClick={() => onCategory(item)}
          >
            {item === "ALL" ? "All markets" : titleCase(item.replace("-", " "))}
          </button>
        ))}
      </div>
      <div className="decision-table-wrap">
        <table className="decision-table">
          <thead>
            <tr>
              <th>#</th><th>Market</th><th>Side</th><th>Price</th><th>Fair</th><th>Edge after costs</th><th>Confidence</th><th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((decision, index) => (
              <tr
                className={decision.marketId === selectedId ? "selected" : ""}
                key={decision.marketId}
                onClick={() => onSelect(decision.marketId)}
              >
                <td>{index + 1}</td>
                <td><strong>{decision.title}</strong><span className="row-reason">{decision.reason}</span></td>
                <td className={`side ${decision.outcome.toLowerCase()}`}>{decision.outcome}</td>
                <td className="number">{decimal(decision.ask)}</td>
                <td className="number">{decimal(decision.rawProbability)}</td>
                <td className={`number edge ${decision.netEdge >= 0 ? "positive" : "negative"}`}>{signedPct(decision.netEdge)}</td>
                <td className="number">{pct(decision.confidence)}</td>
                <td><DecisionLabel action={decision.action} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {decisions.length === 0 ? (
          <div className="empty-table">
            <strong>No decisions in this view</strong>
            <span>Run a scan to create auditable decisions, or change the current filter.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function DecisionInspector({
  decision,
  tab,
  busy,
  maxBetEur,
  message,
  onTab,
  onSimulate,
}: {
  decision?: DashboardDecision;
  tab: InspectorTab;
  busy: boolean;
  maxBetEur: number;
  message?: { kind: "error" | "success"; text: string };
  onTab: (tab: InspectorTab) => void;
  onSimulate: () => void;
}) {
  if (!decision) {
    return (
      <aside className="inspector empty-inspector">
        <ShieldIcon />
        <strong>No fresh decision snapshot</strong>
        <span>Run a scan, then select a market to inspect its evidence and formula trail.</span>
      </aside>
    );
  }

  const tabs: Array<[InspectorTab, string]> = [
    ["WHY", "Why this decision"],
    ["EVIDENCE", `Evidence (${decision.evidence.length})`],
    ["RISKS", `Uncertainty & risks (${decision.risks.length})`],
    ["COSTS", "Costs"],
    ["FORMULA", "Formula trail"],
  ];
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div><span className="selected-marker">SELECTED</span><span>Market decision</span></div>
        {decision.url ? <a href={decision.url} target="_blank" rel="noreferrer">Open market <ExternalIcon /></a> : null}
      </div>
      <div className="title-row"><h2>{decision.title}</h2><span className={`side ${decision.outcome.toLowerCase()}`}>Side: <strong>{decision.outcome}</strong></span></div>
      <div className="decision-metrics">
        <Metric label={decision.priceSource === "orderbook" ? "Executable ask" : "Indicative price"} value={decimal(decision.ask)} />
        <Metric label="Raw fair value" value={decimal(decision.rawProbability)} />
        <Metric label="Edge after costs" value={signedPct(decision.netEdge)} accent />
        <Metric label="Confidence" value={pct(decision.confidence)} />
        <div><span>Decision</span><DecisionLabel action={decision.action} /></div>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Reasoning detail">
        {tabs.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => onTab(value)}>{label}</button>
        ))}
      </div>
      <div className="inspector-body">
        <div className="explanation">
          <InspectorContent decision={decision} tab={tab} />
        </div>
        <div className="order-preview">
          <h3>Paper order preview</h3>
          <dl>
            <div><dt>Configured max risk</dt><dd>{money(maxBetEur)}</dd></div>
            <div><dt>{decision.priceSource === "orderbook" ? "Current executable ask" : "Indicative price"}</dt><dd>{decimal(decision.ask)}</dd></div>
            <div><dt>Selected contract</dt><dd>{decision.outcome}</dd></div>
            <div><dt>Net model edge</dt><dd>{signedPct(decision.netEdge)}</dd></div>
            <div><dt>Evidence sources</dt><dd>{decision.independentEvidenceCount}</dd></div>
          </dl>
          <button className="button simulate" type="button" onClick={onSimulate} disabled={busy || decision.action !== "PAPER_BET"}>
            {busy ? <RefreshIcon className="spin" /> : <PlayIcon />}
            {busy ? "Checking live book…" : "Simulate paper bet"}
          </button>
          <p>Fresh CLOB quotes and all risk limits are checked again before any simulation or live order is recorded.</p>
          {message ? <div className={`inline-message ${message.kind}`} role="status">{message.text}</div> : null}
        </div>
      </div>
    </aside>
  );
}

function InspectorContent({ decision, tab }: { decision: DashboardDecision; tab: InspectorTab }) {
  if (tab === "EVIDENCE") {
    return <DetailList title="Independent evidence" items={decision.evidence} empty="No independent evidence was recorded." />;
  }
  if (tab === "RISKS") {
    return <DetailList title="Known uncertainty" items={decision.risks} empty="No model risks were recorded." warning />;
  }
  if (tab === "COSTS") {
    return (
      <div>
        <h3>Costs included before qualification</h3>
        <dl className="cost-list">
          <div><dt>Half-spread (diagnostic)</dt><dd>{pct(decision.spreadCost)}</dd></div>
          <div><dt>Estimated taker fee / share</dt><dd>{pct(decision.feeCost)}</dd></div>
          <div><dt>Slippage buffer</dt><dd>{pct(decision.slippageCost)}</dd></div>
          <div><dt>Net edge</dt><dd>{signedPct(decision.netEdge)}</dd></div>
        </dl>
      </div>
    );
  }
  if (tab === "FORMULA") return <FormulaTrail decision={decision} />;
  return (
    <div>
      <p className="decision-summary">{decision.reason}</p>
      <ul className="check-list">
        <li><CheckIcon /> Independent evidence: {decision.independentEvidenceCount} source(s)</li>
        <li><CheckIcon /> Data quality: {pct(decision.dataQuality)}</li>
        <li><CheckIcon /> Clarity score: {decision.clarityScore.toFixed(0)} / 100</li>
        <li><CheckIcon /> Liquidity score: {decision.liquidityScore.toFixed(0)} / 100</li>
      </ul>
      <FormulaTrail decision={decision} compact />
    </div>
  );
}

function FormulaTrail({ decision, compact = false }: { decision: DashboardDecision; compact?: boolean }) {
  const reliability = decision.confidence;
  const lines = [
    `Raw fair probability       = ${decimal(decision.rawProbability)}`,
    `Market prior (mid/last)    = ${decimal(decision.marketPriorProbability)}`,
    `Confidence / reliability  = ${decimal(reliability)}`,
    `Conservative fair value   = prior + (raw - prior) × confidence`,
    `                          = ${decimal(decision.calibratedProbability)}`,
    `${decision.priceSource === "orderbook" ? "Executable ask" : "Indicative/last price"} = ${decimal(decision.ask)}`,
    `Estimated fee per share   = ${decimal(decision.feeCost)}`,
    `Slippage buffer           = ${decimal(decision.slippageCost)}`,
    `Edge after costs          = conservative fair - ask - fee - slippage`,
    `                          = ${signedPct(decision.netEdge)}`,
  ];
  return (
    <div className={`formula ${compact ? "compact" : ""}`}>
      <span>Formula trail</span>
      <pre>{lines.join("\n")}</pre>
    </div>
  );
}

function DetailList({ title, items, empty, warning = false }: { title: string; items: string[]; empty: string; warning?: boolean }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? <ul className={`detail-list ${warning ? "warning" : ""}`}>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}
    </div>
  );
}

export function PaperLedger({ orders, exposure, maxExposure }: { orders: DashboardPaperOrder[]; exposure: number; maxExposure: number }) {
  return (
    <section className="lower-panel" id="ledger">
      <div className="panel-heading"><h2>Paper ledger <span>open and recent positions</span></h2><span>Open exposure {money(exposure)} / {money(maxExposure)}</span></div>
      <div className="small-table-wrap">
        <table className="small-table">
          <thead><tr><th>Market</th><th>Side</th><th>Shares</th><th>Avg price</th><th>Edge</th><th>Exposure</th><th>Status</th></tr></thead>
          <tbody>
            {orders.slice(0, 7).map((order) => (
              <tr key={order.id}>
                <td>{order.title}</td><td className={`side ${order.outcome.toLowerCase()}`}>{order.outcome}</td><td>{order.shares.toFixed(3)}</td>
                <td>{decimal(order.price)}</td><td className={order.edge >= 0 ? "positive" : "negative"}>{signedPct(order.edge)}</td>
                <td>{money(order.sizeEur)}</td><td>{order.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 ? <p className="empty-row">No paper orders recorded. Simulate only after reviewing a qualifying candidate.</p> : null}
      </div>
      <p className="panel-note">All positions are paper-only. No capital is at risk.</p>
    </section>
  );
}

export function RunHistory({ runs }: { runs: DashboardRun[] }) {
  return (
    <section className="lower-panel">
      <div className="panel-heading"><h2>Recent runs</h2><span>{runs.length} recorded</span></div>
      <div className="small-table-wrap">
        <table className="small-table">
          <thead><tr><th>Time</th><th>Status</th><th>Command</th><th>Markets</th><th>Candidates</th><th>Duration</th></tr></thead>
          <tbody>
            {runs.slice(0, 7).map((run) => (
              <tr key={run.id}>
                <td>{relativeTime(run.startedAt)}</td>
                <td><span className={`run-status ${run.status}`}><CheckIcon /> {titleCase(run.status)}</span></td>
                <td>{run.command}</td><td>{run.details?.marketsScanned ?? "—"}</td><td>{run.details?.candidates ?? "—"}</td>
                <td>{run.details?.durationMs ? `${(run.details.durationMs / 1000).toFixed(1)}s` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CalibrationPanel({
  calibration,
}: {
  calibration: DashboardData["calibration"];
}) {
  const forecasts = calibration.forecasts;
  const paper = calibration.paper;
  return (
    <section className="lower-panel readiness-panel" id="calibration">
      <div className="panel-heading">
        <h2>Calibration <span>out-of-sample scorecard</span></h2>
        <span>{calibration.forecastCounts.pending} pending</span>
      </div>
      <div className="metric-cards">
        <ScoreCard label="Settled forecasts" value={String(forecasts.settledCount)} />
        <ScoreCard label="Bot Brier" value={optionalFixed(forecasts.brierScore, 4)} />
        <ScoreCard label="Market Brier" value={optionalFixed(forecasts.marketBrierScore, 4)} />
        <ScoreCard
          label="Brier skill"
          value={forecasts.brierSkillScore === undefined ? "—" : signedPct(forecasts.brierSkillScore)}
          state={(forecasts.brierSkillScore ?? 0) > 0 ? "pass" : "pending"}
        />
        <ScoreCard label="Settled paper bets" value={String(paper.settledCount)} />
        <ScoreCard
          label="Paper return"
          value={signedPct(paper.returnOnStake)}
          state={paper.settledCount >= 30 && paper.returnOnStake > 0 ? "pass" : "pending"}
        />
      </div>
      <p className="panel-note">
        Brier skill must remain positive against the contemporaneous market after at least 100 resolved forecasts.
      </p>
    </section>
  );
}

export function ReadinessPanel({
  readiness,
  sportsOdds,
}: {
  readiness: DashboardData["liveReadiness"];
  sportsOdds: DashboardData["sourceHealth"]["sportsOdds"];
}) {
  return (
    <section className="lower-panel readiness-panel" id="readiness">
      <div className="panel-heading">
        <h2>Live readiness <span>all gates are mandatory</span></h2>
        <span className={readiness.ready ? "positive" : "negative"}>
          {readiness.ready ? "READY" : "BLOCKED"}
        </span>
      </div>
      <ul className="gate-list">
        {readiness.gates.map((gate) => (
          <li key={gate.key} className={gate.passed ? "passed" : ""}>
            <span>{gate.passed ? <CheckIcon /> : <ShieldIcon />}</span>
            <div><strong>{gate.label}</strong><small>{gate.detail}</small></div>
          </li>
        ))}
      </ul>
      <div className="source-strip">
        <strong>Sports source: {titleCase(sportsOdds.status.replace("-", " "))}</strong>
        <span>
          {sportsOdds.requestsRemaining === undefined ? "Quota not observed yet" : `${sportsOdds.requestsRemaining} credits remaining`}
          {" · "}{sportsOdds.maxCallsPerScan} calls/scan max
        </span>
      </div>
    </section>
  );
}

export function SettlementPanel({
  settlements,
}: {
  settlements: DashboardData["recentSettlements"];
}) {
  return (
    <section className="lower-panel">
      <div className="panel-heading">
        <h2>Recent settlements</h2>
        <span>{settlements.length} shown</span>
      </div>
      <div className="small-table-wrap">
        <table className="small-table">
          <thead><tr><th>Market</th><th>Bet</th><th>Winner</th><th>Stake</th><th>PnL</th><th>Settled</th></tr></thead>
          <tbody>
            {settlements.slice(0, 7).map((settlement) => (
              <tr key={settlement.id}>
                <td>{settlement.title}</td>
                <td>{settlement.outcome}</td>
                <td>{settlement.winningOutcome ?? "—"}</td>
                <td>{money(settlement.stakeEur)}</td>
                <td className={settlement.pnlEur >= 0 ? "positive" : "negative"}>{money(settlement.pnlEur)}</td>
                <td>{relativeTime(settlement.settledAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {settlements.length === 0 ? <p className="empty-row">No paper positions have resolved yet.</p> : null}
      </div>
    </section>
  );
}

function ScoreCard({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state?: "pass" | "pending";
}) {
  return <div className={`score-card ${state ?? ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function optionalFixed(value: number | undefined, digits: number): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div><span>{label}</span><strong className={accent ? "positive" : ""}>{value}</strong></div>;
}

function DecisionLabel({ action }: { action: DashboardDecision["action"] }) {
  const label = action === "PAPER_BET" ? "PAPER BET" : action === "LIVE_BET" ? "LIVE BLOCKED" : action;
  return <span className={`decision-label ${action.toLowerCase()}`}>{label}</span>;
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function money(value: number): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(value);
}

function decimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function signedPct(value: number): string {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "—";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export type { DecisionFilter, InspectorTab };
