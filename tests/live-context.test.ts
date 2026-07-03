import { describe, expect, it } from "vitest";
import { buildLiveContext } from "@agent-gateway/core";

describe("live context", () => {
  it("fetches weather context for weather prompts", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes("geocoding-api")) {
        return jsonResponse({
          results: [{
            name: "北京",
            country: "中国",
            admin1: "北京市",
            latitude: 39.9042,
            longitude: 116.4074
          }]
        });
      }
      return jsonResponse({
        timezone: "Asia/Shanghai",
        current: {
          time: "2026-07-03T16:00",
          temperature_2m: 30,
          apparent_temperature: 33,
          relative_humidity_2m: 62,
          precipitation: 0,
          weather_code: 1,
          wind_speed_10m: 8
        },
        daily: {
          weather_code: [1],
          temperature_2m_max: [33],
          temperature_2m_min: [24],
          precipitation_probability_max: [20]
        }
      });
    };

    const context = await buildLiveContext({
      prompt: "北京今天天气怎么样？",
      fetcher
    });

    expect(context?.context).toContain("Gateway 已联网查询实时天气");
    expect(context?.context).toContain("北京");
    expect(context?.context).toContain("30");
    expect(context?.events).toEqual([
      {
        type: "tool.started",
        tool: "web_fetch",
        input: { kind: "weather", location: "北京" }
      },
      expect.objectContaining({
        type: "tool.completed",
        tool: "web_fetch",
        output: expect.objectContaining({
          provider: "Open-Meteo",
          current: expect.objectContaining({ temperature: 30 })
        })
      })
    ]);
    expect(calls).toHaveLength(2);
  });

  it("uses the configured default location when the prompt omits a city", async () => {
    const fetcher = async (url: string | URL) => {
      if (String(url).includes("geocoding-api")) {
        return jsonResponse({
          results: [{
            name: "上海",
            country: "中国",
            latitude: 31.2304,
            longitude: 121.4737
          }]
        });
      }
      return jsonResponse({
        current: {
          time: "2026-07-03T16:00",
          temperature_2m: 29,
          apparent_temperature: 31,
          weather_code: 3
        },
        daily: {
          weather_code: [3],
          temperature_2m_max: [32],
          temperature_2m_min: [25]
        }
      });
    };

    const context = await buildLiveContext({
      prompt: "今天天气怎么样？",
      defaultWeatherLocation: "上海",
      fetcher
    });

    expect(context?.events[0]).toMatchObject({
      type: "tool.started",
      tool: "web_fetch",
      input: { kind: "weather", location: "上海" }
    });
    expect(context?.context).toContain("用户未指定城市");
  });

  it("does not add live context for ordinary coding prompts", async () => {
    const context = await buildLiveContext({
      prompt: "分析 package.json",
      fetcher: async () => {
        throw new Error("fetch should not be called");
      }
    });

    expect(context).toBeUndefined();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
