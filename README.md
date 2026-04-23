# maggie_invests_bot
Maggie的美股小宇宙 — Telegram 美股投資社群機器人

## 專案簡介

針對美股投資社群打造的 Telegram Bot，提供會員分級驗證、即時股票分析（Magnificent Seven）、IPO 深度分析、VIP 訂閱制等功能。

**技術架構**：Telegraf.js + SQLite3 + Node-schedule  
**金融資料來源**：Polygon、Twelve Data、Alpha Vantage

---

## 3 個月 Roadmap

### Month 1 — 收費上線（先賺到第一筆錢）

**Week 1-2：手動收款流程跑通**
- [ ] 補齊 `/vip` 指令的方案說明 + 付款資訊（銀行帳號 or LINE Pay）
- [ ] 確認 `/activate_vip` 管理員指令可正常啟用 VIP
- [ ] 建立收款確認 SOP（用戶付款截圖 → 手動啟用）

**Week 3-4：部署上線**
- [ ] 機器人部署到正式伺服器（Railway / Render / VPS）
- [ ] 設定 `.env` 金鑰、Telegram Bot Token
- [ ] 監控穩定性，確保機器人不掉線

**Month 1 目標**：收到第一批 VIP 訂閱，驗證定價是否合理

---

### Month 2 — 金流自動化

**Week 5-6：申請綠界 ECPay 商家帳號**
- [ ] 提交申請（審核約 1-2 週）
- [ ] 同時串接測試環境

**Week 7-8：自動化付款流程**
- [ ] 用戶點 `/subscribe` → 產生綠界付款連結
- [ ] 付款完成 → Webhook 自動觸發 `/activate_vip`
- [ ] 訂閱到期前 3 天自動發提醒訊息

**Month 2 目標**：零人工介入的完整付款 → 升級 VIP 流程

---

### Month 3 — 留存 & 成長

**Week 9-10：提升 VIP 價值感**
- [ ] 股票 watchlist 個人化（每人設定追蹤清單）
- [ ] 每週 VIP 專屬報告（自動推送）
- [ ] 完善 Dashboard（`dashboard/api.js` 已有架構）

**Week 11-12：推薦制度**
- [ ] 推薦碼機制（推薦成功 → 雙方各得 1 週免費）
- [ ] 分析用戶數據，決定是否調整方案或定價

**Month 3 目標**：MRR 可預測、用戶自然增長

---

## VIP 方案

| 方案 | 價格 | 週期 |
|------|------|------|
| 月付 | $49 | 30 天 |
| 季付 | $129 | 90 天 |
| 年付 | $468 | 365 天 |

---

## 會員分級

| Tier | 名稱 | 權限 |
|------|------|------|
| 0 | 新用戶 | 待審核 |
| 1 | Lobby | 基本社群功能 |
| 2 | Certified | 認證會員，需提交持股證明 |
| 3 | VIP | 全功能：完整股票分析、IPO、價格提醒、Dashboard |
