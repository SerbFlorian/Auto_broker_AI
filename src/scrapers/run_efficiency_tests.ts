import { fetchWithFallback } from "../src/utils/httpClient";
import { report as metricsReport } from "../src/utils/metrics";

async function run() {
  console.log("Running lightweight efficiency checks (TS)...");
  const targets = [
    { name: "clicars", url: "https://www.clicars.com/" },
    { name: "ooyyo", url: "https://www.ooyyo.com/" },
  ];

  for (const t of targets) {
    try {
      console.log(`-> Fetching ${t.name}: ${t.url}`);
      const html = await fetchWithFallback(t.url, { useProxy: false });
      console.log(`   fetched ${html?.length || 0} bytes`);
    } catch (e: any) {
      console.error(`   error fetching ${t.name}:`, e.message || e);
    }
  }

  console.log("Metrics:", metricsReport());
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
