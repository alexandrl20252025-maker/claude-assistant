import Anthropic from "@anthropic-ai/sdk";
import { Db } from "./db";
import { Telegram } from "./telegram";
import { memoryResourceFor } from "./constants";

export interface Env {
  DB: D1Database;
  // секреты (wrangler secret)
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  PAIR_CODE: string;
  ANTHROPIC_WEBHOOK_SIGNING_KEY?: string;
  // обычные переменные (их проставляет scripts/deploy.ts из state.json)
  AGENT_ID: string; // агент для разговоров в чате
  SCHEDULED_AGENT_ID: string; // агент для дайджеста и мониторинга
  ENVIRONMENT_ID: string;
  MEMORY_STORE_ID: string;
  DIGEST_DEPLOYMENT_ID: string;
  MONITOR_DEPLOYMENT_ID: string;
  CHAT_BUDGET_CENTS: string;
  WORKSPACE: string;
}

export interface App {
  env: Env;
  db: Db;
  tg: Telegram;
  anthropic: Anthropic;
}

export function makeApp(env: Env): App {
  return {
    env,
    db: new Db(env.DB),
    tg: new Telegram(env.TELEGRAM_BOT_TOKEN),
    anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 }),
  };
}

export function agentIds(env: Env): string[] {
  return [env.AGENT_ID, env.SCHEDULED_AGENT_ID].filter(Boolean);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function consoleUrl(env: Env, sessionId: string) {
  return `https://platform.claude.com/workspaces/${env.WORKSPACE || "default"}/sessions/${sessionId}`;
}

export function memoryResource(env: Env) {
  return memoryResourceFor(env.MEMORY_STORE_ID);
}

export function formatCents(amount: string | undefined | null) {
  const n = Number(amount ?? 0) / 100;
  return `$${n.toFixed(2)}`;
}
