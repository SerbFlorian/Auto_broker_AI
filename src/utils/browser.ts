import { chromium } from "playwright-extra";
import type { Browser, Route } from "playwright";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
import "dotenv/config";

chromium.use(stealthPlugin());

/**
 * Playwright runs without Bright Data proxy — navigations can bill hundreds of
 * sub-requests. Bright Data is capped via brightDataBudget.service + HTTP only.
 */
export async function getBrowserPage() {
  const launchOptions: any = {
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  const browser = await chromium.launch(launchOptions);
  const page = await getNewPage(browser);

  return { browser, page };
}

export async function getNewPage(browser: Browser) {
  const contextOptions: any = {
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  };

  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  await page.route("**/*", (route: Route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url().toLowerCase();

    if (
      url.includes("google-analytics") ||
      url.includes("googletagmanager") ||
      url.includes("facebook") ||
      url.includes("doubleclick") ||
      url.includes("criteo") ||
      url.includes("hotjar")
    ) {
      return route.abort();
    }

    if (["image", "media", "font"].includes(resourceType)) {
      return route.abort();
    }

    return route.continue();
  });

  return page;
}
