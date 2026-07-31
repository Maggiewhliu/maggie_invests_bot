# Maggie Stock AI — v1.0.0-rc.1

**可部署 RC。非正式上線版。**

## 封板模組(十三個;不再修改)
### Bot Core v1(十模組)
maxPain.ts · marketClock.ts · pushTrigger.ts · pushCore.ts · contentRiskGuard.ts ·
tierAccess.ts · licenseRegistry.ts · artifactSeal.ts · massiveQuoteProvider.ts ·
Telegram 垂直切片(commands / publish / transport / recipientAdapter / marketReport)

### EDGAR 三件套
edgarEventAdapter.ts · eventReport.ts(事實模板)· edgarPoller.ts

### 新增(待驗收)
form4Parser.ts · form4Report.ts

## 測試
119 / 119 pass(`npm ci && npm test`,Node ≥ 22.6)· typecheck 乾淨

## 狀態分級
| 類別 | 內容 |
|---|---|
| ✅ 已完成 | 封板十三模組、發布密封管線、四節點、措辭閘門、會員分級 |
| 🧪 Mock 驗證 | 行情 adapter、EDGAR adapter/poller、Telegram transport(皆注入式測試) |
| ⏳ 待真實環境 | 真實 SEC smoke test、真實 Telegram smoke test、PostgreSQL 整合測試 |
| ❌ 尚未實作 | PostgreSQL 版 EDGAR Cursor/Inbox、Form 4 接線、真實資料授權 grant |

## 明確警示
- EDGAR Cursor/Inbox 目前為 **Memory 版,僅供開發測試**,非 production-ready。
- Massive/Options/國會/TRF 資料在 licenseRegistry 填入書面授權前,一律被發布管線擋下。
- 「每週觀察清單」Live 需律師書面意見;目前僅 Shadow/Paper。
