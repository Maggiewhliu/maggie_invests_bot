/** 真實 EDGAR smoke test:只讀不發。需 EDGAR_CONTACT_EMAIL 環境變數。 */
import { EdgarEventAdapter } from "../src/providers/edgarEventAdapter.ts";
import { renderEventFact } from "../src/reports/eventReport.ts";

const email = process.env.EDGAR_CONTACT_EMAIL;
if (!email) { console.error("缺 EDGAR_CONTACT_EMAIL(SEC 政策要求)"); process.exit(1); }
const a = new EdgarEventAdapter(email);   // 使用內建 fetch
const s = await a.getRecentEvents(320193, 10);
console.log(`quality=${s.quality} events=${s.data?.length ?? 0} notes=${(s.notes ?? []).join("; ")}`);
for (const ev of s.data ?? []) console.log("\n" + renderEventFact(ev, "zh-TW"));
console.log("\n(smoke test:未發送、未入庫)");
