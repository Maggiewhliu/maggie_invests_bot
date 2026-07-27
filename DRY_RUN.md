# 本地 Dry Run 操作說明

## 前置
```bash
node -v            # 需 >= 22.6
npm install
npm test           # 63/63 應全過
```

## 1. 純本地跑完整垂直切片(不需要 Telegram token、不需要資料庫)
```bash
node --experimental-strip-types scripts/dryRun.ts
```
會依序執行:`/start` → `/language` → `/account` → `/markets`,
並印出 Mock Transport 實際「送出」的訊息與 delivery 結果。

## 2. 四節點 Dry Run(不對外發送)
```bash
node --experimental-strip-types scripts/dryRunNodes.ts
```
掃過一個交易日的四個節點,印出每個節點的時間窗階段與發布判定
(eligible / skipped_no_change / skipped_data_quality)。**不會呼叫 Telegram。**

## 3. 接真實 Telegram(尚未開通,步驟備查)
1. `.env` 填 `TELEGRAM_BOT_TOKEN`(勿寫入版控)
2. 把 `MockTelegramTransport` 換成 `LiveTelegramTransport`
3. 先只對自己的 chat id 測試,`F_*` flag 逐一開啟
4. 群發前必須完成 README 的「正式發送前清單」

## 4. 資料庫
```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
```
之後把 `MemoryPushStore` 換成 `PostgresPushStore(query)`。
⚠️ 尚未對真實 PostgreSQL 執行整合測試(清單第 1 項)。

## 5. 真實 SEC EDGAR Smoke Test(需網路;在你的環境執行)
```bash
EDGAR_CONTACT_EMAIL=you@example.com node --experimental-strip-types scripts/smokeEdgar.ts
```
- SEC 政策要求 User-Agent 含真實聯絡 email;缺 env 會直接拒絕啟動
- 只讀取 AAPL(CIK 320193)最近申報並列印事實模板,**不發送、不入庫**
- 預期輸出:最近的 Form 4 / 8-K / 13D-G 清單(正規化類型 + Period of Report + 申報日 + SEC 連結)
- 若見 429:SEC 限流,稍後重試(adapter 已內建 5 req/s 保守限速)
