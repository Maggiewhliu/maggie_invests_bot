const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} missing`);
  return value;
};

const token = required("TELEGRAM_BOT_TOKEN");
const secret = required("TELEGRAM_WEBHOOK_SECRET");
const base = required("PUBLIC_BASE_URL").replace(/\/+$/, "");
const url = `${base}/telegram/webhook`;

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const body = await response.json();
if (!response.ok || !body?.ok) throw new Error(`setWebhook failed: ${JSON.stringify(body)}`);
console.log(`Webhook configured: ${url}`);
