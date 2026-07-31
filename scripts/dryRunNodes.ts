/** 四節點 Dry Run:只印判定,絕不對外發送 */
import { windowsFor } from "../src/pushTrigger.ts";
import { MemoryPushStore, evaluateCandidate } from "../src/pushCore.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { buildMarketReport } from "../src/reports/marketReport.ts";
import { MAG7 } from "../src/bot/commands.ts";

const store = new MemoryPushStore();
const snap = await new MockQuoteProvider().getQuotes(MAG7);
// 2026-07-22 週三,掃 08:00–17:00 ET
for (let h = 12; h <= 21; h++) {
  const now = new Date(`2026-07-22T${String(h).padStart(2,"0")}:05:00Z`);
  const ws = windowsFor(now);
  const open = ws.filter(w => w.phase === "open");
  if (!open.length) continue;
  for (const w of open) {
    const rep = buildMarketReport(snap, "zh-TW", now);
    const c = await evaluateCandidate(store, w.node, w.etDate, w.fixedCandidate,
      { decisionVersion: rep.decisionVersion, contentHash: rep.contentHash, dataQuality: rep.dataQuality });
    console.log(`${w.etDate} ${w.scheduledEt} ET  ${w.node.padEnd(20)} fixed=${w.fixedCandidate}  → ${c.status}`);
  }
}
console.log("\n(Dry Run:未呼叫任何 Telegram API)");
