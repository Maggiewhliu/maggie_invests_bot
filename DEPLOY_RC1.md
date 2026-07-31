# 部署到 Railway(agent/import-bot-core-rc1)

## 1) 套用變更並推送(在有 repo 的機器上)
```bash
git checkout agent/import-bot-core-rc1
# 將本次交付的檔案覆蓋進 repo 對應路徑:
#   src/pipeline/quoteCache.ts        (65s + 同日跳過)
#   src/runtime/runtime.ts            (接線工廠,新)
#   src/runtime/server.ts             (Railway 進入點,新)
#   src/providers/types.ts  src/bot/commands.ts  src/reports/marketReport.ts
#   src/providers/mockQuoteProvider.ts
#   test/quoteCache.test.ts test/runtime.test.ts test/botSlice.test.ts
#   .github/workflows/ci.yml
npm ci && npm test && npm run typecheck     # 應 134/134
git add -A
git commit -m "feat: wire QuoteCache into runtime (65s loop, same-day skip, webhook server)"
git push origin agent/import-bot-core-rc1   # ← push 後終端機顯示的就是 commit SHA
```

## 2) Railway 環境變數(必填)
TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / MASSIVE_API_KEY /
ARTIFACT_HMAC_SECRET(長隨機字串)/
PERSONAL_PREVIEW_ENABLED=true / PERSONAL_PREVIEW_USER_ID=981883005 /
F_BASIC_TA=true / DATA_DERIVED_DISPLAY_OK=false /
MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED=false

啟動指令:`node --experimental-strip-types src/runtime/server.ts`

## 3) Webhook(一次性;替換 token 與網址)
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<railway-app>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"

## 4) 何時可測
部署成功後 **等 3 分半**(三批 × 65s),先看 `GET /health`:
`cached: 11/11, quality: "real"` → Telegram 打 `/markets` 應見完整 11 檔。
之前打會誠實回「資料收集中(X/7|Y/4)」——那是正確行為。

## ⚠️ 已知標示
- Recipient/PushStore 為 Memory:重啟即失、去重不跨重啟(正式換 Postgres)
- DEV_LICENSE_MASSIVE 是內部測試授權;正式上線前必換書面授權 grant
