# Project: pollybot

## Architecture
pollybot is a prediction market scanner and trading bot that pulls market data, estimates probabilities, calculates order sizes using Kelly criterion, and manages risk.
- **Scanner Pipeline**: Fetches market info from sources like Polymarket, CoinGecko, weather, and news APIs.
- **Probability Engine**: Estimates outcome probability using heuristics (`src/probability/heuristics.ts`).
- **Risk & Trading Engine**: Manages risk limits, fees, and order sizing using Kelly betting.
- **Web & API**: Vite-based frontend dashboard and backend server.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | E2E Testing Suite | Setup opaque-box E2E test infra and implement Tier 1-4 tests. | none | COMPLETE |
| 2 | Risk & Sizing Refinements | Fractional Kelly, spread/slippage handling, calibration gates, and historical risk controls. | none | COMPLETE |
| 3 | Network Error Handling | HTTP timeouts, exponential backoff retries, and scanner isolation. | none | COMPLETE |
| 4 | News & Search Integration | News/Search source parser and conservative integration in `heuristics.ts`. | none | COMPLETE |
| 5 | E2E Integration & Verification | 137/137 tests plus typecheck/build and adversarial execution hardening. | M1, M2, M3, M4 | COMPLETE |

## Interface Contracts
### News/Search Heuristic Integration
- The news/search source should conform to the existing scanner source interface (typically returning content, title, date, etc.).
- Heuristics in `src/probability/heuristics.ts` will parse news/search sources to compute a raw probability and confidence score.

### Order Sizing
- Kelly sizing calculations in `src/trading/` will accept spread/slippage inputs, and cap sizes appropriately.

## Code Layout
- `src/sources/`: Data sources (e.g. news/search source)
- `src/probability/`: Heuristics and probability estimation
- `src/trading/`: Risk management and sizing
- `tests/`: Automated unit, integration, and E2E test suites
