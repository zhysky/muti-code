import type { AgentEvent } from "./types.js";

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LiveContextResult {
  context: string;
  events: LiveToolEvent[];
}

type LiveToolEvent =
  | Omit<Extract<AgentEvent, { type: "tool.started" }>, "runId">
  | Omit<Extract<AgentEvent, { type: "tool.completed" }>, "runId">;

interface BuildLiveContextInput {
  prompt: string;
  defaultWeatherLocation?: string;
  fetcher?: Fetcher;
}

interface GeoResponse {
  results?: Array<{
    name?: string;
    country?: string;
    admin1?: string;
    latitude?: number;
    longitude?: number;
  }>;
}

interface ForecastResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
}

const DEFAULT_WEATHER_LOCATION = "上海";

const CITY_NAMES = [
  "北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "重庆", "武汉", "西安", "苏州", "天津",
  "长沙", "郑州", "青岛", "厦门", "福州", "合肥", "济南", "昆明", "宁波", "无锡", "佛山", "东莞",
  "香港", "澳门", "台北", "纽约", "洛杉矶", "旧金山", "伦敦", "东京", "首尔", "新加坡", "巴黎", "柏林"
];

export async function buildLiveContext(input: BuildLiveContextInput): Promise<LiveContextResult | undefined> {
  if (!isWeatherPrompt(input.prompt)) return undefined;

  const location = inferWeatherLocation(input.prompt)
    ?? input.defaultWeatherLocation
    ?? process.env.WEATHER_DEFAULT_LOCATION
    ?? process.env.DEFAULT_WEATHER_LOCATION
    ?? DEFAULT_WEATHER_LOCATION;
  const usedDefaultLocation = !inferWeatherLocation(input.prompt);
  const fetcher = input.fetcher ?? fetch;
  const started = {
    type: "tool.started" as const,
    tool: "web_fetch",
    input: { kind: "weather", location }
  };

  try {
    const weather = await fetchWeather(location, fetcher);
    const context = [
      "Gateway 已联网查询实时天气。请直接基于这些数据回答用户，不要再说无法获取实时天气。",
      usedDefaultLocation ? `用户未指定城市，默认查询：${location}。如需其他城市，请提醒用户可以指定城市。` : undefined,
      `数据源：${weather.provider}`,
      `查询城市：${weather.location}`,
      `更新时间：${weather.current.time ?? "未知"}`,
      `当前天气：${weather.current.weather}，气温 ${formatNumber(weather.current.temperature)}°C，体感 ${formatNumber(weather.current.apparentTemperature)}°C，湿度 ${formatOptionalNumber(weather.current.relativeHumidity, "%")}，降水 ${formatOptionalNumber(weather.current.precipitation, "mm")}，风速 ${formatOptionalNumber(weather.current.windSpeed, "km/h")}。`,
      `今日预报：${weather.today.weather}，最高 ${formatNumber(weather.today.temperatureMax)}°C，最低 ${formatNumber(weather.today.temperatureMin)}°C，最大降水概率 ${formatOptionalNumber(weather.today.precipitationProbability, "%")}。`
    ].filter(Boolean).join("\n");

    return {
      context,
      events: [
        started,
        {
          type: "tool.completed",
          tool: "web_fetch",
          output: weather
        }
      ]
    };
  } catch (error) {
    return {
      context: [
        "Gateway 尝试联网查询实时天气，但查询失败。",
        `查询城市：${location}`,
        `失败原因：${error instanceof Error ? error.message : String(error)}`,
        "请向用户说明查询失败，并让用户提供城市或稍后重试。"
      ].join("\n"),
      events: [
        started,
        {
          type: "tool.completed",
          tool: "web_fetch",
          output: {
            kind: "weather",
            location,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      ]
    };
  }
}

function isWeatherPrompt(prompt: string): boolean {
  return /天气|气温|温度|下雨|降雨|weather|forecast|temperature/i.test(prompt);
}

function inferWeatherLocation(prompt: string): string | undefined {
  for (const city of CITY_NAMES) {
    if (prompt.includes(city)) return city;
  }
  const englishMatch = prompt.match(/\bweather\s+(?:in|for)\s+([a-zA-Z][a-zA-Z\s,.-]{1,40})/i);
  if (englishMatch?.[1]) {
    return englishMatch[1].replace(/[?.!，。].*$/, "").trim();
  }
  return undefined;
}

async function fetchWeather(location: string, fetcher: Fetcher) {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", location);
  geoUrl.searchParams.set("count", "1");
  geoUrl.searchParams.set("language", "zh");
  geoUrl.searchParams.set("format", "json");
  const geo = await fetchJson<GeoResponse>(geoUrl, fetcher);
  const result = geo.results?.[0];
  if (!result || typeof result.latitude !== "number" || typeof result.longitude !== "number") {
    throw new Error(`没有找到城市：${location}`);
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(result.latitude));
  forecastUrl.searchParams.set("longitude", String(result.longitude));
  forecastUrl.searchParams.set("current", [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "weather_code",
    "wind_speed_10m"
  ].join(","));
  forecastUrl.searchParams.set("daily", [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max"
  ].join(","));
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "1");

  const forecast = await fetchJson<ForecastResponse>(forecastUrl, fetcher);
  const current = forecast.current ?? {};
  const daily = forecast.daily ?? {};
  return {
    provider: "Open-Meteo",
    location: [result.name, result.admin1, result.country].filter(Boolean).join(", "),
    coordinates: {
      latitude: result.latitude,
      longitude: result.longitude
    },
    timezone: forecast.timezone ?? "auto",
    current: {
      time: current.time,
      weather: weatherCodeText(current.weather_code),
      temperature: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      relativeHumidity: current.relative_humidity_2m,
      precipitation: current.precipitation,
      windSpeed: current.wind_speed_10m
    },
    today: {
      weather: weatherCodeText(daily.weather_code?.[0]),
      temperatureMax: daily.temperature_2m_max?.[0],
      temperatureMin: daily.temperature_2m_min?.[0],
      precipitationProbability: daily.precipitation_probability_max?.[0]
    }
  };
}

async function fetchJson<T>(url: URL, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }
  return JSON.parse(text) as T;
}

function weatherCodeText(code: number | undefined): string {
  if (code === undefined) return "未知";
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "雪";
  if ([95, 96, 99].includes(code)) return "雷雨";
  return `天气代码 ${code}`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "未知" : String(value);
}

function formatOptionalNumber(value: number | undefined, unit: string): string {
  return value === undefined ? "未知" : `${value}${unit}`;
}
