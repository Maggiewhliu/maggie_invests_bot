# Maggie Stock AI — Core Domain Modules (RC1)

單一 TypeScript 系統。網站、Telegram Bot、Email、社群草稿共用同一套 domain modules,
避免同一指標在不同渠道算出不同答案。

## 一鍵重建
```bash
npm ci          # 依 package-lock.json 可重現安裝(勿用 npm install)
npm test        # Node 原生 test runner (需 Node >= 22.6)
# 或
npm run test:tsx
```
目前:**85 tests / 85 pass**(Push Pipeline 已封板為 RC,不再重構)

## 模組
| 檔案 | 職責 | 狀態 |
|---|---|---|
| `src/maxPain.ts` | 真實 Max Pain(OI 結構參考位置)。含 pagination 完整性、重複合約拒絕、SHA-256 存證 | v3 定案 |
| `src/marketClock.ts` | 美股市場時鐘。三大交易所核心時段、假日/半日、日曆版本 | 定案 |
| `src/pushTrigger.ts` | 四節點時間窗(純函數,不保存狀態) | 定案 |
| `src/pushCore.ts` | Occurrence/Candidate/Delivery 三層身分、fencing token、lease 接管、重試 | **RC 封板** |
| `src/contentRiskGuard.ts` | 措辭風險攔截 + 人工核准閘門(績效宣稱禁自動發送) | 定案 |
| `src/tierAccess.ts` | 四級會員 × entitlement × 法域 × 授權 × feature flag | 定案 |
| `src/licenseRegistry.ts` | 資料授權登錄表(供應商×資料集×頻道×法域×用途×效期) | 骨架完成,待實際授權填入 |

## 產品規格(已定案,勿改)
- **四節點推播**:盤前 08:30 / 開盤後 10:00 / 收盤前 15:30(半日 12:30)/ 收盤摘要 16:05(半日 13:05)ET。
  前三個條件式(無變化不發),收盤摘要固定候選(資料品質不合格仍不發)。
- **Max Pain 三層**:summary=Certified(T2)、full=VIP(T3)、GEX/IV Rank=VVIP(T4,整層隱藏)。
- **會員**:T0 Pending / T1 Lobby / T2 Certified(Email+反濫用,**不收持倉證明**)/ T3 VIP / T4 VVIP(隱藏)。
- **絕不**:placeholder 數據、動作指示措辭、把 Max Pain 說成造市商磁吸、績效數字自動發送。

## 正式發送前清單(不阻擋網站開發)
1. 真實 PostgreSQL 整合測試(DDL / claim race / lease takeover / fencing / retry exhaustion)
2. Candidate conflict invariant(同 decisionVersion 不得綁不同 contentHash → 報 invariant violation)
3. `no_recipients` 狀態(candidate 合格但展開後無收件人,不算 missed)
4. Telegram adapter 強制經過 `assertPublishable`
5. `licenseRegistry` 正式接入 `tierAccess`(取代 `DATA_DERIVED_DISPLAY_OK` 單一布林)
6. push_delivery 加 `candidate_id` 外鍵,改等值查詢(移除 LIKE 拼接)
7. 明示 at-least-once 語義,記錄 Telegram message id

## 已知邊界(誠實標註)
- Postgres 實作以注入 query 驗證 SQL 語義,**未對真實資料庫執行**(見清單 1)。
- `licenseRegistry` 目前無資料;詢價與律師意見到位後逐筆填入 grant。
- 詞表為 `pre-legal` 版本,須由台灣執業律師審定後更新 `WORDLIST_VERSION`。

---

# Telegram Bot 重寫 — 第一輪交付(垂直切片)

## 檔案盤點

### 新增
```
src/providers/types.ts              ProviderSnapshot<T> 統一介面 + unavailableSnapshot()
src/providers/mockQuoteProvider.ts  測試/DryRun 行情(fixture,無授權 grant 故無法對外發送)
src/providers/telegramTransport.ts  Live + Mock 兩種 transport(薄封裝,只送不判斷)
src/providers/recipientAdapter.ts   收件人展開(每人自帶 tier/語言/法域)
src/reports/marketReport.ts         市場狀態報告 zh-TW / en(一份判讀多語輸出)
src/pipeline/publish.ts             ★唯一對外送出路徑(完整閘門鏈)
src/bot/commands.ts                 /start /language /account /membership /markets /help
db/migrations/001_init.sql          18 張表
scripts/dryRun.ts                   垂直切片 Dry Run
scripts/dryRunNodes.ts              四節點 Dry Run(不發送)
test/botSlice.test.ts               11 項切片測試
DRY_RUN.md                          本地操作說明
```

### 沿用(不修改)
`maxPain.ts` / `marketClock.ts` / `pushTrigger.ts` / `pushCore.ts`(RC 封板)/ `tierAccess.ts` / `licenseRegistry.ts`

### 修改(已說明原因與影響)
`contentRiskGuard.ts` — 新增 `DISCLAIMER`(免責文字**單一來源**)與 `APPROVED_BOILERPLATE` 白名單。
> 原因:法規必要的免責文字必然含「建議 / advice」等 REVIEW 詞(如「非投資建議」),
> 不白名單則每份合規報告都會被自己的免責聲明攔下。實際踩到後才發現。
> 影響:僅 lint 輸入預處理;詞表、三態判定、發送層邏輯均未變動,`pushCore` 未碰。
> 附帶修正:免責文字原本在兩處各寫一份(內容不同導致白名單失配),現統一為單一定義。

### 淘汰(不再使用,僅供需求參考)
舊 Python 系統全部:`tsla_bot.py` / `webhook_server.py` / `user_tier_manager.py` /
`stock_report_generator.py` / `vip_stock_analyzer.py` / `ipo_analyzer.py` /
`market_sentiment_analyzer.py` / `earnings_sector_analyzer.py` / `auto_promotion.py` /
`send_report.py` / `health_check.py` / `test_system.py`;
舊 Telegraf JS repo;所有 SQLite `user_tiers.db`;GitHub Actions 作為警報引擎的用法。
> 淘汰原因:假數據(`current_price * 0.97` 冒充 Max Pain)、動作指示措辭、
> 台北固定四時段(休市時重複推播)、持倉證明蒐集、多 API key 輪替。

## 驗收對照
| 要求 | 狀態 |
|---|---|
| 一鍵測試 | `npm test` → **85 / 85 pass** |
| typecheck | `npx tsc --noEmit` 乾淨 |
| package.json / tsconfig / .env.example | ✅ |
| PostgreSQL migration | ✅ `db/migrations/001_init.sql`(含 candidate_id 外鍵,等值查詢) |
| Telegram API mock 測試 | ✅ 含 429 retryable 不當已送達 |
| Provider adapter mock 測試 | ✅ 含 provider 掛掉 → 明確不可用、不補值 |
| 中英文 snapshot 測試 | ✅ 兩語皆驗免責存在 + 黑名單詞不存在 |
| Tier 權限測試 | ✅ |
| License flag 關閉不洩漏 | ✅ 一則都不發 |
| Content Risk 攔截 | ✅ 績效宣稱自動管線零送出 |
| 四節點去重 / retry | ✅ 同版本重複發布只送一次 |
| Dry Run 說明 | ✅ `DRY_RUN.md` |

## 尚未接通的真實資料源(誠實列出,勿當已完成)
| 項目 | 狀態 |
|---|---|
| 真實行情 / OHLCV | ❌ 僅 mock fixture,待 Provider 詢價與授權 |
| 真實 Options chain → Max Pain | ❌ 引擎就緒,無資料輸入 |
| SEC EDGAR(Form 4 / 8-K / 13D-G) | ✅ adapter+輪詢器+事實模板完成(mock 驗證);真實 API smoke test 待部署環境執行 |
| 財報 / 經濟事件日曆 | ❌ 未實作(官方 BLS / Fed / 公司 IR 優先) |
| 國會交易(五 adapter 插槽) | ❌ 介面未建 |
| TRF / Off-Exchange | ❌ 介面未建 |
| 13F 機構持倉 | ❌ 未實作 |
| PostgreSQL 實際連線 | ❌ migration 已寫,未對真實 DB 執行 |
| 真 Telegram 發送 | ❌ Live transport 已寫,未接 token,未群發 |

## VVIP 四項能力狀態(照仲裁三態)
| 能力 | 對外名稱 | 狀態 |
|---|---|---|
| AI 選股候選 | 每週重點觀察清單 | **Shadow/Paper**,顯示「驗證中 樣本 0/50」;Live 需樣本達標 + **律師書面意見** |
| 機構異常活動 | 機構異常活動雷達 | Preview;TRF 不推定身分與方向 |
| 主力成本 | 主力成本推估帶 | Preview;Anchored VWAP + Volume Profile,標信心區間 |
| 國會交易 | 國會申報追蹤 | Preview;五 adapter 插槽 + 來源狀態(Official/Licensed/Backup/Unavailable),同筆不重複顯示 |
