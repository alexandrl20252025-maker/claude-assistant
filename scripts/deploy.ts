// Разворачивает посредника в Cloudflare Workers и подключает к нему Telegram-бота.
// Запускать после `npm run setup`. Нужны переменные окружения:
//   ASSISTANT_API_KEY, TELEGRAM_BOT_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { State } from "./setup";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE_FILE = path.join(ROOT, "state.json");
const WORKER_NAME = "claude-assistant-bot";
const DB_NAME = "claude-assistant-db";

const need = ["ASSISTANT_API_KEY", "TELEGRAM_BOT_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Не хватает переменных окружения: ${missing.join(", ")}`);
  process.exit(1);
}
const env = process.env as Record<string, string>;
const state: State = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
for (const k of ["environment_id", "memory_store_id", "chat_agent_id", "scheduled_agent_id", "digest_deployment_id", "monitor_deployment_id"] as const) {
  if (!state[k]) {
    console.error(`В state.json нет ${k} — сначала запустите npm run setup.`);
    process.exit(1);
  }
}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

async function cf<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${p}`, {
    method,
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; result: T; errors?: { code: number; message: string }[] };
  if (!json.success) throw Object.assign(new Error(`Cloudflare ${p}: ${json.errors?.map((e) => e.message).join("; ")}`), { codes: json.errors?.map((e) => e.code) });
  return json.result;
}

async function tg<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

function wrangler(args: string[], input?: string) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  }).toString();
}

async function workersSubdomain(): Promise<string> {
  try {
    const r = await cf<{ subdomain: string }>("GET", "/workers/subdomain");
    if (r.subdomain) return r.subdomain;
  } catch {
    /* субдомена ещё нет */
  }
  const wanted = `assistant-${crypto.randomBytes(3).toString("hex")}`;
  const r = await cf<{ subdomain: string }>("PUT", "/workers/subdomain", { subdomain: wanted });
  console.log(`✓ создан субдомен workers.dev: ${r.subdomain}`);
  return r.subdomain;
}

async function d1Database(): Promise<string> {
  if (state.d1_database_id) return state.d1_database_id;
  const list = await cf<{ uuid: string; name: string }[]>("GET", `/d1/database?name=${DB_NAME}`);
  const found = list.find((d) => d.name === DB_NAME);
  const id = found?.uuid ?? (await cf<{ uuid: string }>("POST", "/d1/database", { name: DB_NAME })).uuid;
  state.d1_database_id = id;
  save();
  console.log(`✓ база D1: ${id}`);
  return id;
}

function writeWranglerToml(d1Id: string) {
  const vars: Record<string, string> = {
    __D1_ID__: d1Id,
    __AGENT_ID__: state.chat_agent_id!,
    __SCHEDULED_AGENT_ID__: state.scheduled_agent_id!,
    __ENVIRONMENT_ID__: state.environment_id!,
    __MEMORY_STORE_ID__: state.memory_store_id!,
    __DIGEST_DEPLOYMENT_ID__: state.digest_deployment_id!,
    __MONITOR_DEPLOYMENT_ID__: state.monitor_deployment_id!,
    __CHAT_BUDGET_CENTS__: String(Math.round(cfg.chat.budget_usd * 100)),
    __WORKSPACE__: cfg.workspace,
  };
  let toml = fs.readFileSync(path.join(ROOT, "wrangler.template.toml"), "utf8");
  for (const [k, v] of Object.entries(vars)) toml = toml.replaceAll(k, v);
  fs.writeFileSync(path.join(ROOT, "wrangler.toml"), toml);
}

async function main() {
  const me = await tg<{ username: string }>("getMe", {});
  console.log(`✓ бот найден: @${me.username}`);

  const subdomain = await workersSubdomain();
  const d1Id = await d1Database();
  writeWranglerToml(d1Id);

  console.log("… применяю схему базы");
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file", "schema.sql", "--yes"]);

  console.log("… публикую Worker");
  wrangler(["deploy"]);

  const webhookSecret = crypto.randomBytes(24).toString("hex");
  const pairCode = crypto.randomInt(100000, 999999).toString();
  console.log("… сохраняю секреты");
  wrangler(
    ["secret", "bulk"],
    JSON.stringify({
      ANTHROPIC_API_KEY: env.ASSISTANT_API_KEY,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TG_WEBHOOK_SECRET: webhookSecret,
      PAIR_CODE: pairCode,
    }),
  );

  const url = `https://${WORKER_NAME}.${subdomain}.workers.dev`;
  for (let i = 0; i < 10; i++) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  await tg("setWebhook", {
    url: `${url}/telegram`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "new", description: "Новый разговор (память сохранится)" },
      { command: "digest", description: "Дайджест сейчас" },
      { command: "monitor", description: "Проверить мониторинг сейчас" },
      { command: "stop", description: "Остановить ответ" },
      { command: "status", description: "Расход текущего разговора" },
      { command: "help", description: "Справка" },
    ],
  });

  state.worker_url = url;
  state.bot_username = me.username;
  save();

  console.log(`
✅ Готово.

1) Привяжите бота к себе: откройте https://t.me/${me.username} и отправьте:
     /start ${pairCode}

2) Чтобы ответы приходили сразу, зарегистрируйте вебхук в Claude Console:
     Manage → Webhooks → Add endpoint
     URL:     ${url}/anthropic
     События: session.status_idled, session.status_terminated, deployment_run.failed
   Потом отправьте боту:  /key whsec_…  (ключ подписи, который покажет Console)
   Без вебхука бот тоже работает, но ответ приходит с задержкой до 2 минут.
`);
}

main().catch((err) => {
  console.error("\n✗ Ошибка:", err instanceof Error ? err.message : err);
  process.exit(1);
});
