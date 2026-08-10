// Stateful rate limit counter per process run
let rateLimitAttempts = 0;

export async function mockFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url.toString();
  const scenario = process.env.MOCK_SCENARIO || "";

  // 1. Simulating global failures
  if (scenario === "timeout") {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }

  // 2. Polymarket Gamma Events endpoint
  if (urlStr.includes("/events")) {
    if (scenario === "rate-limit") {
      rateLimitAttempts++;
      if (rateLimitAttempts <= 2) {
        return new Response("Too Many Requests", { status: 429 });
      }
    }
    if (scenario === "partial-failure" && urlStr.includes("offset=10")) {
      return new Response("Internal Server Error", { status: 500 });
    }

    const now = new Date();
    const targetDateStr = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const weatherDateStr = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const sportsDateStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const normalEvents = [
      {
        id: "e1",
        title: "Solana Markets",
        tags: ["crypto"],
        startDate: now.toISOString(),
        endDate: targetDateStr,
        markets: [
          {
            id: "m1",
            question: "Will Sol hit $200 before July?",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.4", "0.6"]),
            clobTokenIds: JSON.stringify(["t-yes-m1", "t-no-m1"]),
            active: true,
            closed: false,
            endDate: targetDateStr,
          },
        ],
      },
      {
        id: "e2",
        title: "NYC Temperature",
        tags: ["weather"],
        startDate: now.toISOString(),
        endDate: weatherDateStr,
        markets: [
          {
            id: "m2",
            question: "Will the high temperature in NYC exceed 80 degrees Fahrenheit on TargetDate?",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.6", "0.4"]),
            clobTokenIds: JSON.stringify(["t-yes-m2", "t-no-m2"]),
            active: true,
            closed: false,
            endDate: weatherDateStr,
          },
        ],
      },
      {
        id: "e3",
        title: "Lakers vs Celtics Game",
        tags: ["sports"],
        startDate: now.toISOString(),
        endDate: sportsDateStr,
        markets: [
          {
            id: "m3",
            question: "Will the Boston Celtics beat the Los Angeles Lakers?",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.5", "0.5"]),
            clobTokenIds: JSON.stringify(["t-yes-m3", "t-no-m3"]),
            active: true,
            closed: false,
            endDate: sportsDateStr,
          },
        ],
      },
      {
        id: "e4",
        title: "Political Nomination",
        tags: ["politics"],
        startDate: now.toISOString(),
        endDate: targetDateStr,
        markets: [
          {
            id: "m4",
            question: "Will Biden officially announce nomination of X to Supreme Court?",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.2", "0.8"]),
            clobTokenIds: JSON.stringify(["t-yes-m4", "t-no-m4"]),
            active: true,
            closed: false,
            endDate: targetDateStr,
          },
        ],
      },
      {
        id: "e5",
        title: "Bitcoin Dip Market",
        tags: ["crypto"],
        startDate: now.toISOString(),
        endDate: targetDateStr,
        markets: [
          {
            id: "m5",
            question: "Will Bitcoin dip to $50,000 by December 31, 2026?",
            rules: "Resolves immediately if a final Low price is equal to or lower than $50,000.",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.7", "0.3"]),
            clobTokenIds: JSON.stringify(["t-yes-m5", "t-no-m5"]),
            active: true,
            closed: false,
            endDate: targetDateStr,
          },
        ],
      },
    ];

    if (scenario === "flash-crash") {
      // BTC YES price adjusts quickly to 0.95
      normalEvents[4]!.markets![0]!.outcomePrices = JSON.stringify(["0.95", "0.05"]);
    }

    return new Response(JSON.stringify(normalEvents), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Polymarket Gamma Single Market endpoint
  if (urlStr.includes("/markets/")) {
    const marketId = urlStr.split("/markets/")[1]?.split("?")[0] || "";
    if (scenario === "market-not-found" || marketId === "missing") {
      return new Response("Not Found", { status: 404 });
    }

    let closed = false;
    let resolved = false;
    let outcomes = ["Yes", "No"];
    let outcomePrices = ["0.5", "0.5"];
    let winningOutcome = "";
    let umaResolutionStatus = "proposed";

    if (scenario === "resolved-yes") {
      closed = true;
      resolved = true;
      outcomePrices = ["1.0", "0.0"];
      winningOutcome = "Yes";
    } else if (scenario === "postponed" && marketId === "m3") {
      closed = true;
      resolved = false;
      outcomePrices = ["0.5", "0.5"];
      umaResolutionStatus = "50-50";
    } else if (scenario === "disputed") {
      closed = true;
      resolved = false;
      umaResolutionStatus = "disputed";
    } else if (scenario === "negative-price") {
      closed = true;
      resolved = false;
      outcomePrices = ["-0.01", "1.01"];
    }

    return new Response(
      JSON.stringify({
        id: marketId,
        question: `Question for ${marketId}`,
        outcomes: JSON.stringify(outcomes),
        outcomePrices: JSON.stringify(outcomePrices),
        closed,
        active: !closed,
        umaResolutionStatus,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Polymarket CLOB Orderbook endpoint
  if (urlStr.includes("/book")) {
    const tokenIdMatch = urlStr.match(/token_id=([^&]+)/);
    const tokenId = tokenIdMatch ? tokenIdMatch[1] : "unknown";

    let bids = [{ price: "0.38", size: "100" }];
    let asks = [{ price: "0.40", size: "100" }];

    if (tokenId?.includes("-m5")) {
      bids = [{ price: "0.68", size: "100" }];
      asks = [{ price: "0.70", size: "100" }];
    } else if (tokenId?.includes("-m4")) {
      bids = [{ price: "0.18", size: "100" }];
      asks = [{ price: "0.20", size: "100" }];
    } else if (tokenId?.includes("-m2")) {
      bids = [{ price: "0.58", size: "100" }];
      asks = [{ price: "0.60", size: "100" }];
    } else if (tokenId?.includes("-no-m4")) {
      bids = [{ price: "0.78", size: "100" }];
      asks = [{ price: "0.80", size: "100" }];
    }

    if (scenario === "low-liquidity") {
      asks = [{ price: "0.40", size: "0.1" }]; // ask depth = 0.04 < minBet 0.05
    } else if (scenario === "high-slippage") {
      bids = [{ price: "0.50", size: "10" }];
      asks = [{ price: "0.64", size: "10" }]; // spread 0.14
    }

    return new Response(
      JSON.stringify({
        market: "test-market",
        asset_id: tokenId,
        timestamp: new Date().toISOString(),
        bids,
        asks,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. CoinGecko simple price
  if (urlStr.includes("/simple/price")) {
    if (scenario === "cg-rate-limit") {
      return new Response("Too Many Requests", { status: 429 });
    }
    let btcPrice = 60000;
    if (scenario === "flash-crash") {
      btcPrice = 51000;
    }
    return new Response(
      JSON.stringify({
        solana: { usd: 150, last_updated_at: Math.floor(Date.now() / 1000) },
        bitcoin: { usd: btcPrice, last_updated_at: Math.floor(Date.now() / 1000) },
        ethereum: { usd: 3000, last_updated_at: Math.floor(Date.now() / 1000) },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 6. CoinGecko historical market chart
  if (urlStr.includes("/market_chart")) {
    if (scenario === "cg-volatility-fail") {
      return new Response("Service Unavailable", { status: 503 });
    }
    const prices: Array<[number, number]> = [];
    const basePrice = urlStr.includes("solana") ? 150 : urlStr.includes("bitcoin") ? 60000 : 3000;
    for (let i = 0; i < 30; i++) {
      prices.push([Date.now() - i * 24 * 60 * 60 * 1000, basePrice * (1 + (Math.sin(i) * 0.05))]);
    }
    return new Response(JSON.stringify({ prices }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 7. Open-Meteo geocoding and weather forecast
  if (urlStr.includes("geocoding-api.open-meteo.com")) {
    return new Response(
      JSON.stringify({
        results: [
          {
            name: "Prague",
            admin1: "Hlavni mesto Praha",
            country_code: "CZ",
            latitude: 50.0875,
            longitude: 14.4213,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (urlStr.includes("open-meteo.com")) {
    const isLow = urlStr.includes("temperature_2m_min");
    const daily = {
      time: [new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)],
      temperature_2m_max: [85.0],
      temperature_2m_min: [65.0],
      rain_sum: [0.2],
      precipitation_sum: [0.25],
      snowfall_sum: [0.0],
      wind_speed_10m_max: [18.0],
      wind_gusts_10m_max: [28.0],
    };
    return new Response(JSON.stringify({ daily }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (urlStr.includes("api.met.no/weatherapi/locationforecast")) {
    const targetDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const timeseries = Array.from({ length: 24 }, (_, hour) => ({
      time: `${targetDate}T${String(hour).padStart(2, "0")}:00:00Z`,
      data: {
        instant: {
          details: {
            air_temperature: hour >= 13 && hour <= 16 ? 29.4 : 18.3,
            wind_speed: 6.5,
            wind_speed_of_gust: 10.5,
          },
        },
        next_1_hours: { details: { precipitation_amount: hour === 8 ? 0.2 : 0 } },
      },
    }));
    return new Response(JSON.stringify({ properties: { timeseries } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (urlStr.includes("api.weather.gov/points")) {
    return new Response(
      JSON.stringify({ properties: { forecastHourly: "https://api.weather.gov/gridpoints/TEST/1,1/forecast/hourly" } }),
      { status: 200, headers: { "Content-Type": "application/geo+json" } },
    );
  }

  if (urlStr.includes("api.weather.gov/gridpoints/TEST/1,1/forecast/hourly")) {
    const targetDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const periods = Array.from({ length: 24 }, (_, hour) => ({
      startTime: `${targetDate}T${String(hour).padStart(2, "0")}:00:00-04:00`,
      temperature: hour >= 13 && hour <= 16 ? 85 : 65,
      temperatureUnit: "F",
      windSpeed: "8 mph",
      windGust: "15 mph",
    }));
    return new Response(JSON.stringify({ properties: { periods } }), {
      status: 200,
      headers: { "Content-Type": "application/geo+json" },
    });
  }

  // 8. Sports Odds API
  if (urlStr.includes("api.the-odds-api.com")) {
    if (urlStr.match(/\/v4\/sports\/?(\?|$)/)) {
      return new Response(
        JSON.stringify([
          {
            key: "basketball_nba",
            group: "Basketball",
            title: "NBA",
            description: "US Basketball",
            active: true,
            has_outrights: false,
          },
          {
            key: "soccer_fifa_world_cup",
            group: "Soccer",
            title: "FIFA World Cup",
            description: "FIFA World Cup 2026",
            active: true,
            has_outrights: false,
          },
          {
            key: "soccer_fifa_world_cup_winner",
            group: "Soccer",
            title: "FIFA World Cup Winner",
            description: "FIFA World Cup Winner 2026",
            active: true,
            has_outrights: true,
          },
          {
            key: "esports_lol",
            group: "Esports",
            title: "League of Legends",
            description: "League of Legends matches",
            active: true,
            has_outrights: false,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (scenario === "sports-zero-books") {
      return new Response(
        JSON.stringify([
          {
            id: "nba-game-1",
            sport_key: "basketball_nba",
            commence_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            home_team: "Los Angeles Lakers",
            away_team: "Boston Celtics",
            bookmakers: [],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr.includes("soccer_fifa_world_cup_winner") && urlStr.includes("markets=outrights")) {
      return new Response(
        JSON.stringify([
          {
            id: "world-cup-winner",
            sport_key: "soccer_fifa_world_cup_winner",
            commence_time: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            home_team: null,
            away_team: null,
            bookmakers: [
              {
                key: "williamhill",
                title: "William Hill",
                last_update: new Date().toISOString(),
                markets: [
                  {
                    key: "outrights",
                    outcomes: [
                      { name: "France", price: 4.0 },
                      { name: "Argentina", price: 5.0 },
                      { name: "Spain", price: 8.0 },
                      { name: "England", price: 8.0 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("esports_lol") && urlStr.includes("markets=h2h")) {
      return new Response(
        JSON.stringify([
          {
            id: "lol-match-1",
            sport_key: "esports_lol",
            commence_time: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
            home_team: "Team Liquid",
            away_team: "Karmine Corp",
            bookmakers: [
              {
                key: "pinnacle",
                title: "Pinnacle",
                last_update: new Date().toISOString(),
                markets: [
                  {
                    key: "h2h",
                    outcomes: [
                      { name: "Team Liquid", price: 2.25 },
                      { name: "Karmine Corp", price: 1.65 },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify([
        {
          id: "nba-game-1",
          sport_key: "basketball_nba",
          commence_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          home_team: "Los Angeles Lakers",
          away_team: "Boston Celtics",
          bookmakers: [
            {
              key: "circa",
              title: "Circa",
              last_update: new Date().toISOString(),
              markets: [
                {
                  key: "h2h",
                  outcomes: [
                    { name: "Los Angeles Lakers", price: 1.91 },
                    { name: "Boston Celtics", price: 1.91 },
                  ],
                },
              ],
            },
          ],
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 9. BLS, official tech status pages and official RSS feeds
  if (urlStr.includes("api.bls.gov/publicAPI")) {
    const values = [
      ["2026", "M05", "333.979"],
      ["2026", "M04", "332.407"],
      ["2026", "M03", "331.235"],
      ["2026", "M02", "330.128"],
      ["2026", "M01", "329.111"],
      ["2025", "M12", "328.912"],
      ["2025", "M11", "328.100"],
      ["2025", "M10", "327.500"],
      ["2025", "M09", "326.800"],
      ["2025", "M08", "326.200"],
      ["2025", "M07", "325.900"],
      ["2025", "M06", "325.500"],
      ["2025", "M05", "325.000"],
    ];
    return new Response(
      JSON.stringify({
        status: "REQUEST_SUCCEEDED",
        Results: { series: [{ seriesID: "CUSR0000SA0", data: values.map(([year, period, value]) => ({ year, period, value })) }] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (urlStr.includes("status.openai.com") || urlStr.includes("status.anthropic.com")) {
    return new Response(
      JSON.stringify({
        incidents: [
          {
            name: "Claude API elevated errors",
            status: "resolved",
            impact: "minor",
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            resolved_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            incident_updates: [{ body: "Claude service has been restored for affected users.", status: "resolved" }],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  if (urlStr.includes("openai.com/news/rss.xml") || urlStr.includes("openai.com/blog/rss.xml")) {
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>OpenAI News</title>' +
        "<item><title>Introducing GPT-5.6</title><pubDate>Tue, 30 Jun 2026 00:00:00 GMT</pubDate></item>" +
        "</channel></rss>",
      { status: 200, headers: { "Content-Type": "application/xml" } },
    );
  }

  // 9b. FRED (St. Louis Fed) macro observations
  if (urlStr.includes("api.stlouisfed.org")) {
    const idMatch = urlStr.match(/series_id=([^&]+)/);
    const seriesId = idMatch?.[1] ?? "";
    const base: Record<string, number> = {
      FEDFUNDS: 3.63,
      DGS10: 4.4,
      DGS2: 3.9,
      A191RL1Q225SBEA: 2.1,
      PCEPI: 123,
      PCEPILFE: 124,
    };
    const level = base[seriesId] ?? 3.0;
    const isIndex = seriesId === "PCEPI" || seriesId === "PCEPILFE";
    const now = new Date();
    const observations: Array<{ date: string; value: string }> = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const value = isIndex ? level * Math.pow(1.024, -i / 12) : level + Math.sin(i) * 0.02;
      observations.push({ date: d.toISOString().slice(0, 10), value: value.toFixed(isIndex ? 3 : 2) });
    }
    return new Response(JSON.stringify({ observations }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 9c. Wikidata culture (movie/TV release dates) — must precede the news mock since the
  // wbsearchentities action string contains "search".
  if (urlStr.includes("wikidata.org/w/api.php")) {
    if (urlStr.includes("wbsearchentities")) {
      return new Response(
        JSON.stringify({ search: [{ id: "Q1", label: "Test Movie", description: "2026 film" }], success: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (urlStr.includes("wbgetentities")) {
      return new Response(
        JSON.stringify({
          entities: {
            Q1: {
              labels: { en: { value: "Test Movie" } },
              claims: {
                P577: [{ mainsnak: { datavalue: { value: { time: "+2026-07-15T00:00:00Z", precision: 11 } } } }],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // 10. News / Search Mock (Google News RSS feed -> XML with <item><title>)
  if (urlStr.includes("news") || urlStr.includes("search") || urlStr.includes("gdelt")) {
    const rssHeader =
      '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>News Query</title>';
    if (scenario === "news-empty") {
      return new Response(`${rssHeader}</channel></rss>`, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    return new Response(
      `${rssHeader}` +
        "<item><title>Biden officially announces nomination of X to Supreme Court</title></item>" +
        "<item><title>Senate confirms nomination of X</title></item>" +
        "</channel></rss>",
      { status: 200, headers: { "Content-Type": "application/xml" } }
    );
  }

  // 11. Diagnostics checkHttp endpoints
  if (urlStr.includes("/status")) {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
  if (urlStr.includes("/time")) {
    return new Response(String(Date.now()), { status: 200 });
  }
  if (urlStr.includes("/api/geoblock")) {
    const blocked = scenario === "geoblocked";
    return new Response(JSON.stringify({ blocked, country: "US", region: "NY", ip: "127.0.0.1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (urlStr.includes("polymarket.com") && !urlStr.includes("/api/")) {
    return new Response("OK", { status: 200 });
  }

  // 12. FMP market-cap quotes (free "stable" tier serves one symbol per request)
  if (urlStr.includes("financialmodelingprep.com")) {
    const symbolMatch = urlStr.match(/[?&]symbol=([^&]+)/);
    const symbol = symbolMatch?.[1] ? decodeURIComponent(symbolMatch[1]) : "";
    const caps: Record<string, { name: string; marketCap: number }> = {
      NVDA: { name: "Nvidia", marketCap: 4.5e12 },
      AAPL: { name: "Apple", marketCap: 4.0e12 },
      MSFT: { name: "Microsoft", marketCap: 3.8e12 },
      GOOGL: { name: "Alphabet", marketCap: 2.5e12 },
      AMZN: { name: "Amazon", marketCap: 2.3e12 },
      META: { name: "Meta", marketCap: 1.6e12 },
      AVGO: { name: "Broadcom", marketCap: 1.2e12 },
      TSLA: { name: "Tesla", marketCap: 1.4e12 },
      "BRK-B": { name: "Berkshire Hathaway", marketCap: 1.05e12 },
      TSM: { name: "TSMC", marketCap: 1.1e12 },
      LLY: { name: "Eli Lilly", marketCap: 0.8e12 },
    };
    const hit = caps[symbol];
    if (!hit) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify([{ symbol, name: hit.name, price: 100, marketCap: hit.marketCap }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response("OK", { status: 200 });
}
