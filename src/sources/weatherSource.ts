import type { Db } from "../db";
import { getCachedSource, saveSourceObservation } from "../db";
import type { NormalizedMarket, SourceObservation } from "../types";
import { daysUntil, nowIso } from "../utils";
import { resilientFetchJson } from "../utils/fetch";

/**
 * Free, key-less weather forecasts from Open-Meteo (https://open-meteo.com).
 * Terms allow non-commercial use without an API key. We only activate when we can
 * confidently map the market to a known city and the resolution date is inside the
 * 16-day forecast horizon; otherwise we fail closed with a reason, so the bot never
 * forecasts weather it cannot actually see.
 */

interface KnownCity {
  latitude: number;
  longitude: number;
  label: string;
  stationCode?: string;
}

// Polymarket temperature markets often resolve from Wunderground airport stations.
// Prefer these coordinates over city-centre aliases when the rules expose a station code.
const KNOWN_STATIONS: Record<string, KnownCity> = {
  EGLC: { latitude: 51.5053, longitude: 0.0553, label: "London City Airport (EGLC)", stationCode: "EGLC" },
  OEJN: { latitude: 21.6796, longitude: 39.1565, label: "Jeddah King Abdulaziz Airport (OEJN)", stationCode: "OEJN" },
  LLBG: { latitude: 32.0067, longitude: 34.879, label: "Tel Aviv Ben Gurion Airport (LLBG)", stationCode: "LLBG" },
  LTFM: { latitude: 41.2626, longitude: 28.7429, label: "Istanbul International Airport (LTFM)", stationCode: "LTFM" },
};

// Coordinates for the cities that recur in Polymarket weather markets. Keyed by lowercase
// aliases so we avoid an ambiguous geocoding round-trip and stay deterministic.
const KNOWN_CITIES: Record<string, KnownCity> = {
  "new york": { latitude: 40.7143, longitude: -74.006, label: "New York City" },
  "new york city": { latitude: 40.7143, longitude: -74.006, label: "New York City" },
  nyc: { latitude: 40.7143, longitude: -74.006, label: "New York City" },
  "los angeles": { latitude: 34.0522, longitude: -118.2437, label: "Los Angeles" },
  "la": { latitude: 34.0522, longitude: -118.2437, label: "Los Angeles" },
  "san francisco": { latitude: 37.7749, longitude: -122.4194, label: "San Francisco" },
  "san diego": { latitude: 32.7157, longitude: -117.1647, label: "San Diego" },
  "las vegas": { latitude: 36.1699, longitude: -115.1398, label: "Las Vegas" },
  chicago: { latitude: 41.85, longitude: -87.65, label: "Chicago" },
  miami: { latitude: 25.7617, longitude: -80.1918, label: "Miami" },
  orlando: { latitude: 28.5383, longitude: -81.3792, label: "Orlando" },
  tampa: { latitude: 27.9506, longitude: -82.4572, label: "Tampa" },
  houston: { latitude: 29.7604, longitude: -95.3698, label: "Houston" },
  dallas: { latitude: 32.7767, longitude: -96.797, label: "Dallas" },
  "san antonio": { latitude: 29.4241, longitude: -98.4936, label: "San Antonio" },
  phoenix: { latitude: 33.4484, longitude: -112.074, label: "Phoenix" },
  denver: { latitude: 39.7392, longitude: -104.9847, label: "Denver" },
  austin: { latitude: 30.2672, longitude: -97.7431, label: "Austin" },
  seattle: { latitude: 47.6062, longitude: -122.3321, label: "Seattle" },
  portland: { latitude: 45.5152, longitude: -122.6784, label: "Portland" },
  boston: { latitude: 42.3584, longitude: -71.0598, label: "Boston" },
  philadelphia: { latitude: 39.9526, longitude: -75.1652, label: "Philadelphia" },
  atlanta: { latitude: 33.749, longitude: -84.388, label: "Atlanta" },
  detroit: { latitude: 42.3314, longitude: -83.0458, label: "Detroit" },
  cleveland: { latitude: 41.4993, longitude: -81.6944, label: "Cleveland" },
  "kansas city": { latitude: 39.0997, longitude: -94.5786, label: "Kansas City" },
  "st louis": { latitude: 38.627, longitude: -90.1994, label: "St. Louis" },
  "st. louis": { latitude: 38.627, longitude: -90.1994, label: "St. Louis" },
  nashville: { latitude: 36.1627, longitude: -86.7816, label: "Nashville" },
  charlotte: { latitude: 35.2271, longitude: -80.8431, label: "Charlotte" },
  "new orleans": { latitude: 29.9511, longitude: -90.0715, label: "New Orleans" },
  "washington": { latitude: 38.8951, longitude: -77.0364, label: "Washington, D.C." },
  "washington dc": { latitude: 38.8951, longitude: -77.0364, label: "Washington, D.C." },
  london: { latitude: 51.5074, longitude: -0.1278, label: "London" },
  paris: { latitude: 48.8566, longitude: 2.3522, label: "Paris" },
  berlin: { latitude: 52.52, longitude: 13.405, label: "Berlin" },
  madrid: { latitude: 40.4168, longitude: -3.7038, label: "Madrid" },
  rome: { latitude: 41.9028, longitude: 12.4964, label: "Rome" },
  warsaw: { latitude: 52.2297, longitude: 21.0122, label: "Warsaw" },
  munich: { latitude: 48.1372, longitude: 11.5755, label: "Munich" },
  milan: { latitude: 45.4642, longitude: 9.19, label: "Milan" },
  ankara: { latitude: 39.9334, longitude: 32.8597, label: "Ankara" },
  tokyo: { latitude: 35.6762, longitude: 139.6503, label: "Tokyo" },
  "hong kong": { latitude: 22.3193, longitude: 114.1694, label: "Hong Kong" },
  shanghai: { latitude: 31.2304, longitude: 121.4737, label: "Shanghai" },
  chengdu: { latitude: 30.5728, longitude: 104.0668, label: "Chengdu" },
  jinan: { latitude: 36.6512, longitude: 117.1201, label: "Jinan" },
  zhengzhou: { latitude: 34.7466, longitude: 113.6254, label: "Zhengzhou" },
  lucknow: { latitude: 26.8467, longitude: 80.9462, label: "Lucknow" },
  karachi: { latitude: 24.8607, longitude: 67.0011, label: "Karachi" },
  "cape town": { latitude: -33.9249, longitude: 18.4241, label: "Cape Town" },
  toronto: { latitude: 43.6532, longitude: -79.3832, label: "Toronto" },
  montreal: { latitude: 45.5017, longitude: -73.5673, label: "Montreal" },
  vancouver: { latitude: 49.2827, longitude: -123.1207, label: "Vancouver" },
  sydney: { latitude: -33.8688, longitude: 151.2093, label: "Sydney" },
  melbourne: { latitude: -37.8136, longitude: 144.9631, label: "Melbourne" },
  "mexico city": { latitude: 19.4326, longitude: -99.1332, label: "Mexico City" },
};

type WeatherMetric = "high" | "low" | "rain" | "precipitation" | "snowfall" | "wind" | "wind_gust";

interface WeatherTarget {
  city: KnownCity;
  metric: WeatherMetric;
  unit: "fahrenheit" | "celsius" | "inch" | "mm" | "mph" | "kmh";
  targetDate: string;
  leadDays: number;
  dailyVariable: string;
}

export function detectWeatherTarget(market: NormalizedMarket): WeatherTarget | { reason: string } {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  const station = detectKnownStation(`${market.title} ${market.rules ?? ""} ${market.resolutionSource ?? ""}`);
  if (station) return buildWeatherTarget(market, station);
  const cityEntry = Object.entries(KNOWN_CITIES).find(([alias]) => hasAlias(text, alias));
  if (!cityEntry) return { reason: "No supported city was recognized in the weather market" };

  return buildWeatherTarget(market, cityEntry[1]);
}

function buildWeatherTarget(market: NormalizedMarket, city: KnownCity): WeatherTarget | { reason: string } {
  const text = `${market.title} ${market.rules ?? ""}`.toLowerCase();
  const metric = detectWeatherMetric(text);
  if (!metric) return { reason: "Weather market does not reference a supported forecast metric" };
  const targetDate = extractWeatherTargetDate(market);
  const lead = targetDate ? calendarLeadDays(targetDate) : daysUntil(market.endDate);
  if (lead === undefined) return { reason: "Weather market has no usable forecast date" };
  if (lead < 0) return { reason: "Weather market resolution date is in the past" };
  if (lead > 16) return { reason: "Resolution date is beyond the 16-day forecast horizon" };

  const unit = detectWeatherUnit(text, metric);
  return {
    city,
    metric,
    unit,
    targetDate: targetDate ?? new Date(market.endDate!).toISOString().slice(0, 10),
    leadDays: lead,
    dailyVariable: dailyVariableFor(metric),
  };
}

export async function getWeatherObservation(db: Db, market: NormalizedMarket): Promise<SourceObservation> {
  const observations = await getWeatherObservations(db, market);
  return observations.find(
    (observation) => observation.available && observation.payload.provider === "open-meteo",
  ) ?? observations.find((observation) => observation.available) ?? observations[0]!;
}

export async function getWeatherObservations(db: Db, market: NormalizedMarket): Promise<SourceObservation[]> {
  let target = detectWeatherTarget(market);
  const stationCode = extractWeatherStationCode(
    `${market.title} ${market.rules ?? ""} ${market.resolutionSource ?? ""}`,
  );
  if (stationCode && (!("reason" in target) ? target.city.stationCode !== stationCode : true)) {
    const station = KNOWN_STATIONS[stationCode] ?? await resolveAviationStation(db, stationCode);
    if (station) target = buildWeatherTarget(market, station);
  }
  if ("reason" in target && target.reason === "No supported city was recognized in the weather market") {
    const dynamicCity = await geocodeWeatherCity(db, market);
    if (dynamicCity) target = buildWeatherTarget(market, dynamicCity);
  }
  if ("reason" in target) {
    return [{ sourceType: "weather", sourceKey: `weather:none:${market.marketId}`, collectedAt: nowIso(), payload: {}, available: false, reason: target.reason }];
  }

  const providers = [
    getOpenMeteoEnsembleObservation(db, market, target),
    getOpenMeteoWeatherObservation(db, market, target),
    getMetNorwayWeatherObservation(db, market, target),
    getNwsWeatherObservation(db, market, target),
  ];
  if (target.city.stationCode && (target.metric === "high" || target.metric === "low")) {
    providers.push(getAviationWeatherObservation(db, market, target));
  }
  return Promise.all(providers);
}

async function getOpenMeteoEnsembleObservation(
  db: Db,
  market: NormalizedMarket,
  target: WeatherTarget,
): Promise<SourceObservation> {
  const model = target.leadDays <= 7 ? "icon_seamless" : "gfs_seamless";
  const cacheKey = `open-meteo-ensemble:${model}:${target.city.label}:${target.metric}:${target.unit}:${target.targetDate}`;
  const cached = getCachedSource(db, "weather", cacheKey);
  if (cached) return cached;
  try {
    const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
    url.searchParams.set("latitude", String(target.city.latitude));
    url.searchParams.set("longitude", String(target.city.longitude));
    url.searchParams.set("daily", target.dailyVariable);
    url.searchParams.set("models", model);
    url.searchParams.set("forecast_days", String(Math.min(16, Math.max(7, Math.ceil(target.leadDays) + 2))));
    url.searchParams.set("timezone", "auto");
    if (target.unit === "fahrenheit" || target.unit === "celsius") url.searchParams.set("temperature_unit", target.unit);
    if (target.unit === "inch" || target.unit === "mm") url.searchParams.set("precipitation_unit", target.unit);
    if (target.unit === "mph" || target.unit === "kmh") url.searchParams.set("wind_speed_unit", target.unit);

    const { data } = await resilientFetchJson<{ daily?: Record<string, unknown> }>(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "pollybot/1.2 probabilistic weather bot" },
      maxRetries: 1,
    });
    const times = Array.isArray(data.daily?.time) ? (data.daily.time as unknown[]).map(String) : [];
    const dayIndex = times.indexOf(target.targetDate);
    if (dayIndex < 0) throw new Error("Ensemble did not include the resolution date");
    const memberPrefix = `${target.dailyVariable}_member`;
    const ensembleValues = Object.entries(data.daily ?? {})
      .filter(([key, value]) => key.startsWith(memberPrefix) && Array.isArray(value))
      .map(([, value]) => Number((value as unknown[])[dayIndex]))
      .filter((value) => Number.isFinite(value));
    if (ensembleValues.length < 10) throw new Error("Ensemble returned fewer than 10 usable members");
    const forecastValue = ensembleValues.reduce((sum, value) => sum + value, 0) / ensembleValues.length;
    const observation: SourceObservation = {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
      payload: {
        provider: "open-meteo-ensemble",
        model,
        location: target.city.label,
        stationCode: target.city.stationCode,
        metric: target.metric,
        unit: target.unit,
        forecastValue,
        ensembleValues,
        memberCount: ensembleValues.length,
        dailyVariable: target.dailyVariable,
        targetDate: target.targetDate,
        leadDays: target.leadDays,
      },
      available: true,
      // It is used as the primary probability distribution, but is correlated with the
      // Open-Meteo deterministic forecast and therefore is not an extra independent source.
      independent: false,
      quality: target.leadDays <= 3 ? 0.84 : target.leadDays <= 7 ? 0.74 : 0.58,
    };
    saveSourceObservation(db, market.marketId, observation);
    return observation;
  } catch (error) {
    return unavailableWeather(cacheKey, "open-meteo-ensemble", target.city.label, error instanceof Error ? error.message : String(error));
  }
}

async function getOpenMeteoWeatherObservation(
  db: Db,
  market: NormalizedMarket,
  target: WeatherTarget,
): Promise<SourceObservation> {
  const cacheKey = `open-meteo:${target.city.label}:${target.metric}:${target.unit}:${target.targetDate}`;
  const cached = getCachedSource(db, "weather", cacheKey);
  if (cached) return cached;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(target.city.latitude));
    url.searchParams.set("longitude", String(target.city.longitude));
    url.searchParams.set("daily", target.dailyVariable);
    if (target.unit === "fahrenheit" || target.unit === "celsius") {
      url.searchParams.set("temperature_unit", target.unit);
    } else if (target.unit === "inch" || target.unit === "mm") {
      url.searchParams.set("precipitation_unit", target.unit);
    } else if (target.unit === "mph" || target.unit === "kmh") {
      url.searchParams.set("wind_speed_unit", target.unit);
    }
    url.searchParams.set("forecast_days", "16");
    url.searchParams.set("timezone", "auto");

    const { data } = await resilientFetchJson<{ daily?: Record<string, unknown> }>(url, { timeoutMs: 12_000, headers: { "user-agent": "pollybot/1.1 research bot" } });
    const times = Array.isArray(data.daily?.time) ? (data.daily.time as unknown[]).map(String) : [];
    const values = Array.isArray(data.daily?.[target.dailyVariable])
      ? data.daily[target.dailyVariable] as unknown[]
      : [];
    const dayIndex = times.indexOf(target.targetDate);
    const forecastValue = Number(dayIndex >= 0 ? values[dayIndex] : undefined);
    if (!Number.isFinite(forecastValue)) {
      throw new Error("Forecast did not include the resolution date");
    }

    const observation: SourceObservation = {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      payload: {
        provider: "open-meteo",
        location: target.city.label,
        metric: target.metric,
        unit: target.unit,
        forecastValue,
        dailyVariable: target.dailyVariable,
        targetDate: target.targetDate,
        leadDays: target.leadDays,
      },
      available: true,
      independent: true,
      // Near-term forecasts are far more trustworthy than two-week-out forecasts.
      quality: target.leadDays <= 3 ? 0.78 : target.leadDays <= 7 ? 0.6 : 0.42,
    };
    saveSourceObservation(db, market.marketId, observation);
    return observation;
  } catch (error) {
    return {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payload: { provider: "open-meteo", location: target.city.label },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getMetNorwayWeatherObservation(
  db: Db,
  market: NormalizedMarket,
  target: WeatherTarget,
): Promise<SourceObservation> {
  const cacheKey = `met-norway:${target.city.label}:${target.metric}:${target.unit}:${target.targetDate}`;
  const cached = getCachedSource(db, "weather", cacheKey);
  if (cached) return cached;

  try {
    const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
    url.searchParams.set("lat", target.city.latitude.toFixed(4));
    url.searchParams.set("lon", target.city.longitude.toFixed(4));

    const { data } = await resilientFetchJson<{
      properties?: {
        timeseries?: Array<{
          time?: string;
          data?: {
            instant?: { details?: Record<string, unknown> };
            next_1_hours?: { details?: Record<string, unknown> };
            next_6_hours?: { details?: Record<string, unknown> };
          };
        }>;
      };
    }>(url, {
      timeoutMs: 12_000,
      headers: { "user-agent": "pollybot/1.1 weather research bot" },
    });

    const timeseries = data.properties?.timeseries ?? [];
    const value = dailyValueFromMetNorway(timeseries, target);
    if (value === undefined) throw new Error("MET Norway forecast did not include a usable value for the resolution date");

    const observation: SourceObservation = {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      payload: {
        provider: "met-norway-locationforecast",
        location: target.city.label,
        metric: target.metric,
        unit: target.unit,
        forecastValue: value,
        targetDate: target.targetDate,
        leadDays: target.leadDays,
      },
      available: true,
      independent: true,
      quality: target.leadDays <= 3 ? 0.72 : target.leadDays <= 7 ? 0.55 : 0.35,
    };
    saveSourceObservation(db, market.marketId, observation);
    return observation;
  } catch (error) {
    return {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      payload: { provider: "met-norway-locationforecast", location: target.city.label },
      available: false,
      independent: true,
      quality: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getNwsWeatherObservation(
  db: Db,
  market: NormalizedMarket,
  target: WeatherTarget,
): Promise<SourceObservation> {
  const cacheKey = `nws-hourly:${target.city.label}:${target.metric}:${target.unit}:${target.targetDate}`;
  const cached = getCachedSource(db, "weather", cacheKey);
  if (cached) return cached;

  if (!isLikelyUnitedStates(target.city)) {
    return unavailableWeather(cacheKey, "nws-hourly", target.city.label, "NWS forecast is only available for US locations");
  }
  if (target.metric !== "high" && target.metric !== "low" && target.metric !== "wind" && target.metric !== "wind_gust") {
    return unavailableWeather(cacheKey, "nws-hourly", target.city.label, "NWS hourly forecast does not provide usable daily amount for this weather metric");
  }

  try {
    const pointsUrl = new URL(`https://api.weather.gov/points/${target.city.latitude.toFixed(4)},${target.city.longitude.toFixed(4)}`);
    const point = await resilientFetchJson<{ properties?: { forecastHourly?: string } }>(pointsUrl, {
      timeoutMs: 12_000,
      headers: {
        "user-agent": "pollybot/1.1 weather research bot",
        accept: "application/geo+json",
      },
    });
    const forecastHourly = point.data.properties?.forecastHourly;
    if (!forecastHourly) throw new Error("NWS point metadata did not include an hourly forecast URL");
    const hourly = await resilientFetchJson<{
      properties?: {
        periods?: Array<{
          startTime?: string;
          temperature?: number;
          temperatureUnit?: string;
          windSpeed?: string;
          windGust?: string | null;
        }>;
      };
    }>(forecastHourly, {
      timeoutMs: 12_000,
      headers: {
        "user-agent": "pollybot/1.1 weather research bot",
        accept: "application/geo+json",
      },
    });

    const value = dailyValueFromNws(hourly.data.properties?.periods ?? [], target);
    if (value === undefined) throw new Error("NWS hourly forecast did not include a usable value for the resolution date");

    const observation: SourceObservation = {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      payload: {
        provider: "nws-hourly",
        location: target.city.label,
        metric: target.metric,
        unit: target.unit,
        forecastValue: value,
        targetDate: target.targetDate,
        leadDays: target.leadDays,
      },
      available: true,
      independent: true,
      quality: target.leadDays <= 3 ? 0.74 : target.leadDays <= 7 ? 0.5 : 0.25,
    };
    saveSourceObservation(db, market.marketId, observation);
    return observation;
  } catch (error) {
    return unavailableWeather(
      cacheKey,
      "nws-hourly",
      target.city.label,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function dailyValueFromMetNorway(
  timeseries: Array<{
    time?: string;
    data?: {
      instant?: { details?: Record<string, unknown> };
      next_1_hours?: { details?: Record<string, unknown> };
      next_6_hours?: { details?: Record<string, unknown> };
    };
  }>,
  target: WeatherTarget,
): number | undefined {
  const values: number[] = [];
  for (const entry of timeseries) {
    if (!entry.time?.startsWith(target.targetDate)) continue;
    const instant = entry.data?.instant?.details ?? {};
    if (target.metric === "high" || target.metric === "low") {
      const celsius = Number(instant.air_temperature);
      if (Number.isFinite(celsius)) values.push(target.unit === "fahrenheit" ? celsiusToFahrenheit(celsius) : celsius);
    } else if (target.metric === "wind" || target.metric === "wind_gust") {
      const ms = Number(target.metric === "wind_gust" ? instant.wind_speed_of_gust : instant.wind_speed);
      if (Number.isFinite(ms)) values.push(convertWindFromMetersPerSecond(ms, target.unit));
    } else {
      const next1 = Number(entry.data?.next_1_hours?.details?.precipitation_amount);
      const next6 = Number(entry.data?.next_6_hours?.details?.precipitation_amount);
      const mm = Number.isFinite(next1) ? next1 : Number.isFinite(next6) ? next6 / 6 : undefined;
      if (mm !== undefined) values.push(target.unit === "inch" ? mm / 25.4 : mm);
    }
  }
  if (values.length === 0) return undefined;
  if (target.metric === "low") return Math.min(...values);
  if (target.metric === "rain" || target.metric === "precipitation" || target.metric === "snowfall") {
    return values.reduce((sum, value) => sum + Math.max(0, value), 0);
  }
  return Math.max(...values);
}

function dailyValueFromNws(
  periods: Array<{
    startTime?: string;
    temperature?: number;
    temperatureUnit?: string;
    windSpeed?: string;
    windGust?: string | null;
  }>,
  target: WeatherTarget,
): number | undefined {
  const values: number[] = [];
  for (const period of periods) {
    if (!period.startTime?.startsWith(target.targetDate)) continue;
    if (target.metric === "high" || target.metric === "low") {
      const temperature = Number(period.temperature);
      if (!Number.isFinite(temperature)) continue;
      const unit = String(period.temperatureUnit ?? "F").toUpperCase();
      const celsius = unit === "C" ? temperature : fahrenheitToCelsius(temperature);
      values.push(target.unit === "fahrenheit" ? celsiusToFahrenheit(celsius) : celsius);
    } else {
      const parsed = parseNwsWindMph(target.metric === "wind_gust" ? period.windGust ?? period.windSpeed : period.windSpeed);
      if (parsed !== undefined) values.push(target.unit === "kmh" ? parsed * 1.609344 : parsed);
    }
  }
  if (values.length === 0) return undefined;
  return target.metric === "low" ? Math.min(...values) : Math.max(...values);
}

async function getAviationWeatherObservation(
  db: Db,
  market: NormalizedMarket,
  target: WeatherTarget,
): Promise<SourceObservation> {
  const stationCode = target.city.stationCode;
  const cacheKey = `aviationweather-metar:${stationCode}:${target.targetDate}:${target.metric}:${target.unit}`;
  if (!stationCode) return unavailableWeather(cacheKey, "aviationweather-metar", target.city.label, "No ICAO station code was available");
  const cached = getCachedSource(db, "weather", cacheKey);
  if (cached) return cached;
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (target.targetDate > todayUtc) {
    return unavailableWeather(cacheKey, "aviationweather-metar", target.city.label, "The station observation window has not started");
  }

  try {
    const url = new URL("https://aviationweather.gov/api/data/metar");
    url.searchParams.set("ids", stationCode);
    url.searchParams.set("format", "json");
    url.searchParams.set("hours", "96");
    const { data } = await resilientFetchJson<Array<{ reportTime?: string; obsTime?: number; temp?: number }>>(url, {
      timeoutMs: 12_000,
      maxRetries: 1,
      headers: { "user-agent": "pollybot/1.2 station observation research bot" },
    });
    const approximateOffsetHours = Math.max(-12, Math.min(14, Math.round(target.city.longitude / 15)));
    const temperatures = (Array.isArray(data) ? data : [])
      .filter((row) => {
        const timestamp = row.obsTime ? row.obsTime * 1000 : Date.parse(String(row.reportTime ?? ""));
        if (!Number.isFinite(timestamp)) return false;
        const localDate = new Date(timestamp + approximateOffsetHours * 3_600_000).toISOString().slice(0, 10);
        return localDate === target.targetDate;
      })
      .map((row) => Number(row.temp))
      .filter(Number.isFinite);
    if (temperatures.length === 0) throw new Error("No METAR temperature observations were available for the target local date");
    const celsiusExtreme = target.metric === "low" ? Math.min(...temperatures) : Math.max(...temperatures);
    const observedExtreme = target.unit === "fahrenheit" ? celsiusToFahrenheit(celsiusExtreme) : celsiusExtreme;
    const approximateLocalEnd = Date.parse(`${target.targetDate}T23:59:59Z`) - approximateOffsetHours * 3_600_000;
    const observationComplete = Date.now() > approximateLocalEnd + 2 * 3_600_000;
    const observation: SourceObservation = {
      sourceType: "weather",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + (observationComplete ? 12 * 60 : 10) * 60_000).toISOString(),
      payload: {
        provider: "aviationweather-metar",
        location: target.city.label,
        stationCode,
        metric: target.metric,
        unit: target.unit,
        targetDate: target.targetDate,
        observedExtreme,
        observationCount: temperatures.length,
        observationComplete,
        approximateUtcOffsetHours: approximateOffsetHours,
      },
      available: true,
      independent: true,
      quality: observationComplete ? 0.96 : 0.86,
      reason: observationComplete ? undefined : "The station extreme is observed-so-far; forecasts still determine the remainder of the day",
    };
    saveSourceObservation(db, market.marketId, observation);
    return observation;
  } catch (error) {
    return unavailableWeather(cacheKey, "aviationweather-metar", target.city.label, error instanceof Error ? error.message : String(error));
  }
}

function unavailableWeather(sourceKey: string, provider: string, location: string, reason: string): SourceObservation {
  return {
    sourceType: "weather",
    sourceKey,
    collectedAt: nowIso(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    payload: { provider, location },
    available: false,
    independent: true,
    quality: 0,
    reason,
  };
}

function isLikelyUnitedStates(city: KnownCity): boolean {
  return city.latitude >= 18 && city.latitude <= 72 && city.longitude >= -170 && city.longitude <= -60;
}

function celsiusToFahrenheit(value: number): number {
  return value * 9 / 5 + 32;
}

function fahrenheitToCelsius(value: number): number {
  return (value - 32) * 5 / 9;
}

function convertWindFromMetersPerSecond(value: number, unit: WeatherTarget["unit"]): number {
  if (unit === "kmh") return value * 3.6;
  return value * 2.2369362921;
}

function parseNwsWindMph(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  const finite = matches.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function detectWeatherMetric(text: string): WeatherMetric | undefined {
  if (/\b(wind gust|gusts?|gusting)\b/.test(text)) return "wind_gust";
  if (/\b(wind|winds|windy)\b/.test(text)) return "wind";
  if (/\b(snow|snowfall|blizzard)\b/.test(text)) return "snowfall";
  if (/\b(rain|rainfall|showers?)\b/.test(text)) return "rain";
  if (/\b(precipitation|precip|wet)\b/.test(text)) return "precipitation";
  if (/\b(temperature|temp|degrees|°|fahrenheit|celsius|hot|warm|cold|high|low)\b/.test(text)) {
    return /\b(low|lowest|minimum|coldest|min temp|low temp|daily min|absolute daily min)\b/.test(text) ? "low" : "high";
  }
  return undefined;
}

function detectWeatherUnit(
  text: string,
  metric: WeatherMetric,
): WeatherTarget["unit"] {
  if (metric === "high" || metric === "low") {
    return /\b(celsius|°\s*c|degrees c|deg c)\b/.test(text) ? "celsius" : "fahrenheit";
  }
  if (metric === "wind" || metric === "wind_gust") {
    return /\b(km\/h|kph|kmh|kilometers per hour)\b/.test(text) ? "kmh" : "mph";
  }
  return /\b(mm|millimeters?)\b/.test(text) ? "mm" : "inch";
}

function dailyVariableFor(metric: WeatherMetric): string {
  switch (metric) {
    case "low":
      return "temperature_2m_min";
    case "rain":
      return "rain_sum";
    case "precipitation":
      return "precipitation_sum";
    case "snowfall":
      return "snowfall_sum";
    case "wind":
      return "wind_speed_10m_max";
    case "wind_gust":
      return "wind_gusts_10m_max";
    case "high":
    default:
      return "temperature_2m_max";
  }
}

function hasAlias(text: string, alias: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, "i").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectKnownStation(text: string): KnownCity | undefined {
  for (const [code, station] of Object.entries(KNOWN_STATIONS)) {
    const pattern = new RegExp(`(?:/|\\b)${escapeRegExp(code)}(?:\\b|[/?#])`, "i");
    if (pattern.test(text)) return station;
  }
  return undefined;
}

export function extractWeatherStationCode(text: string): string | undefined {
  const urlMatch = text.match(/wunderground\.com\/history\/daily\/[^\s?#]+\/([A-Z0-9]{4})(?:[/?#\s.]|$)/i);
  const noaaSiteMatch = text.match(/[?&]site=([A-Z][A-Z0-9]{3})(?:[&#\s.]|$)/i);
  const labeledMatch = text.match(/\b(?:icao|airport|weather|wunderground)?\s*station(?:\s+code)?\s*[:#-]?\s*\(?([A-Z][A-Z0-9]{3})\)?\b/i);
  const parenthetical = text.match(/\b(?:airport|aerodrome)\b[^.()]{0,80}\(([A-Z][A-Z0-9]{3})\)/i);
  const code = (urlMatch?.[1] ?? noaaSiteMatch?.[1] ?? labeledMatch?.[1] ?? parenthetical?.[1])?.toUpperCase();
  return code && /^[A-Z][A-Z0-9]{3}$/.test(code) ? code : undefined;
}

async function resolveAviationStation(db: Db, stationCode: string): Promise<KnownCity | undefined> {
  const cacheKey = `aviationweather-airport:${stationCode}`;
  const cached = getCachedSource(db, "weather-station-meta", cacheKey);
  if (cached?.available) {
    const latitude = Number(cached.payload.latitude);
    const longitude = Number(cached.payload.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude, label: String(cached.payload.label ?? stationCode), stationCode };
    }
  }
  try {
    const url = new URL("https://aviationweather.gov/api/data/airport");
    url.searchParams.set("ids", stationCode);
    url.searchParams.set("format", "json");
    const { data } = await resilientFetchJson<Array<{ icaoId?: string; name?: string; lat?: number; lon?: number }>>(url, {
      timeoutMs: 12_000,
      maxRetries: 1,
      headers: { "user-agent": "pollybot/1.2 station metadata research bot" },
    });
    const row = Array.isArray(data) ? data[0] : undefined;
    const latitude = Number(row?.lat);
    const longitude = Number(row?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
    const label = `${String(row?.name ?? "Weather station")} (${stationCode})`;
    saveSourceObservation(db, null, {
      sourceType: "weather-station-meta",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      payload: { latitude, longitude, label, stationCode },
      available: true,
      independent: true,
      quality: 0.95,
    });
    return { latitude, longitude, label, stationCode };
  } catch {
    return undefined;
  }
}

async function geocodeWeatherCity(db: Db, market: NormalizedMarket): Promise<KnownCity | undefined> {
  const query = extractWeatherLocationQuery(market);
  if (!query) return undefined;
  const cacheKey = `open-meteo-geocode:${query.toLowerCase()}`;
  const cached = getCachedSource(db, "weather-geocode", cacheKey);
  if (cached?.available) {
    const latitude = Number(cached.payload.latitude);
    const longitude = Number(cached.payload.longitude);
    const label = String(cached.payload.label ?? query);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude, label };
  }

  try {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query);
    url.searchParams.set("count", "1");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");
    const { data } = await resilientFetchJson<{
      results?: Array<{ latitude?: number; longitude?: number; name?: string; admin1?: string; country_code?: string }>;
    }>(url, { timeoutMs: 8_000, headers: { "user-agent": "pollybot/1.1 research bot" } });
    const result = data.results?.[0];
    if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) return undefined;
    const label = [result.name, result.admin1, result.country_code].filter(Boolean).join(", ");
    const observation: SourceObservation = {
      sourceType: "weather-geocode",
      sourceKey: cacheKey,
      collectedAt: nowIso(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      available: true,
      independent: false,
      quality: 0.55,
      payload: {
        provider: "open-meteo-geocoding",
        query,
        label,
        latitude: result.latitude,
        longitude: result.longitude,
      },
    };
    saveSourceObservation(db, null, observation);
    return { latitude: result.latitude!, longitude: result.longitude!, label };
  } catch {
    return undefined;
  }
}

export function extractWeatherLocationQuery(market: NormalizedMarket): string | undefined {
  const title = market.title.replace(/\([^)]*\)/g, " ");
  const match = title.match(/\b(?:in|for|at|near)\s+([A-Z][A-Za-z.' -]{2,40}?)(?=\s+(?:on|by|before|after|this|next|today|tomorrow|exceed|above|below|over|under|hit|reach|be|rain|snow|wind|temperature|temp|degrees?)\b|[?,]|$)/);
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!value || /\b(will|the|a|an|market|weather)\b/i.test(value)) return undefined;
  return value;
}

function extractWeatherTargetDate(market: NormalizedMarket): string | undefined {
  const text = `${market.title} ${market.rules ?? ""}`;
  const endYear = market.endDate ? new Date(market.endDate).getUTCFullYear() : new Date().getUTCFullYear();
  const monthName =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthFirst = new RegExp(`\\b(?:on|for|by)\\s+${monthName}\\.?\\s+(\\d{1,2})(?:,?\\s*('?\\d{2,4}))?\\b`, "i");
  const dayFirst = new RegExp(`\\b(?:on|for|by)\\s+(\\d{1,2})\\s+${monthName}\\.?(?:\\s*('?\\d{2,4}))?\\b`, "i");
  const first = text.match(monthFirst);
  if (first) return formatTargetDate(String(first[1]), Number(first[2]), first[3], endYear);
  const second = text.match(dayFirst);
  if (second) return formatTargetDate(String(second[2]), Number(second[1]), second[3], endYear);
  return undefined;
}

function formatTargetDate(monthName: string, day: number, rawYear: string | undefined, fallbackYear: number): string | undefined {
  const month = monthIndex(monthName);
  if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  let year = fallbackYear;
  if (rawYear) {
    const cleaned = rawYear.replace("'", "");
    year = cleaned.length === 2 ? 2000 + Number(cleaned) : Number(cleaned);
  }
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

function monthIndex(monthName: string): number | undefined {
  const value = monthName.toLowerCase().replace(/\.$/, "");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.findIndex((month) => value.startsWith(month));
  return index >= 0 ? index : undefined;
}

function calendarLeadDays(targetDate: string): number | undefined {
  const match = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (target - today) / 86_400_000;
}
