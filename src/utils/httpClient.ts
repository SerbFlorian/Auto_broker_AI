import axios, { AxiosInstance } from "axios";
import { incr } from "./metrics.js";
import { isBrightDataEnabled } from "./secrets.js";
import { tryConsumeBrightDataBudget } from "../services/brightDataBudget.service.js";
import * as https from "https";

/**
 * HTTP client for scrapers.
 * Bright Data / PROXY_URL only when BRIGHTDATA_ENABLED=true (default false).
 */
export const createHttpClient = (
  customHeaders?: Record<string, string>,
  options?: { useProxy?: boolean },
): AxiosInstance => {
  const wantProxy = options?.useProxy ?? true;
  const bdEnabled = isBrightDataEnabled();
  const useProxy = wantProxy && bdEnabled;

  const defaultHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8,de;q=0.7",
    ...customHeaders,
  };

  const config: any = {
    headers: defaultHeaders,
    timeout: 30000,
    httpsAgent: new https.Agent({
      // Only relax TLS when actually using unlocker/proxy paths
      rejectUnauthorized: !useProxy,
    }),
  };

  const bdApiKey = process.env.BRIGHTDATA_API_KEY;
  const bdZone = process.env.BRIGHTDATA_ZONE;
  const bdCountry = process.env.BRIGHTDATA_COUNTRY || "es";
  const proxyUrl = process.env.PROXY_URL;

  if (useProxy && bdApiKey && bdZone) {
    if (proxyUrl && proxyUrl.includes("brd-customer")) {
      const url = new URL(proxyUrl);
      config.proxy = {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname,
        port: parseInt(url.port, 10),
        auth: {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
      };
    } else {
      config.headers["x-brd-zone"] = bdZone;
      config.headers["x-brd-country"] = bdCountry;
      config.headers["Authorization"] = `Bearer ${bdApiKey}`;
    }
  } else if (useProxy && proxyUrl) {
    const url = new URL(proxyUrl);
    config.proxy = {
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: parseInt(url.port, 10),
      auth: {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      },
    };
  }

  return axios.create(config);
};

export async function fetchWithFallback(
  url: string,
  options?: { customHeaders?: Record<string, string>; useProxy?: boolean },
): Promise<string> {
  incr("httpRequests", 1);
  const httpClient = createHttpClient(options?.customHeaders, {
    useProxy: false,
  });
  try {
    const response = await httpClient.get(url);
    return response.data;
  } catch (error: any) {
    const shouldFallback =
      isBrightDataEnabled() &&
      (error.response?.status === 403 ||
        error.response?.status === 429 ||
        error.code === "ECONNABORTED" ||
        String(error.message || "").includes("Cloudflare"));

    if (shouldFallback && (await tryConsumeBrightDataBudget("scraper"))) {
      console.warn(
        `⚠️ Fallback: Request to ${url} failed (${error.message}). Retrying with proxy...`,
      );
      incr("proxyFallbacks", 1);
      const proxiedHttpClient = createHttpClient(options?.customHeaders, {
        useProxy: true,
      });
      const proxiedResponse = await proxiedHttpClient.get(url);
      return proxiedResponse.data;
    }
    if (shouldFallback) {
      console.warn(
        `💸 Fallback skipped (${url.slice(0, 80)}) — scraper Bright Data budget exhausted`,
      );
    }
    throw error;
  }
}
