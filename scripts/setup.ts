// Создаёт (или обновляет) всё на стороне Anthropic: среду, память, двух агентов
// и два расписания. Повторный запуск безопасен: найдёт созданное по state.json и
// обновит. Память при повторном запуске НЕ перезаписывается — агент мог её дополнить.
//
//   ASSISTANT_API_KEY=sk-ant-... npm run setup
// (ключ берётся из ASSISTANT_API_KEY, а не из ANTHROPIC_API_KEY, чтобы облачная
//  сессия Claude Code случайно не начала тратить этот ключ на себя)

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { MEMORY_STORE_NAME, memoryResourceFor } from "../src/constants";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATE_FILE = path.join(ROOT, "state.json");

interface Config {
  workspace: string;
  timezone: string;
  chat: { model: string; effort: string; budget_usd: number };
  scheduled: { model: string; effort: string };
  digest: { cron: string; budget_usd: number };
  monitor: { cron: string; budget_usd: number };
}

export interface State {
  environment_id?: string;
  memory_store_id?: string;
  chat_agent_id?: string;
  scheduled_agent_id?: string;
  family_agent_id?: string;
  digest_deployment_id?: string;
  monitor_deployment_id?: string;
  d1_database_id?: string;
  worker_url?: string;
  bot_username?: string;
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const cfg = JSON.parse(read("config.json")) as Config;
const state: State = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
const cents = (usd: number) => String(Math.round(usd * 100));

const apiKey = process.env.ASSISTANT_API_KEY;
if (!apiKey) {
  console.error("Нет ASSISTANT_API_KEY. Добавьте ключ из Claude Console (Settings → API Keys) в переменные окружения.");
  process.exit(1);
}
const client = new Anthropic({ apiKey });

async function checkAccess() {
  try {
    await client.beta.agents.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Ключ ASSISTANT_API_KEY не подошёл (401).");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("У ключа нет доступа к Managed Agents (403).");
    throw err;
  }
}

async function upsertEnvironment() {
  const config = { type: "cloud" as const, networking: { type: "unrestricted" as const } };
  if (state.environment_id) {
    await client.beta.environments.update(state.environment_id, { config });
    console.log(`✓ среда обновлена: ${state.environment_id}`);
  } else {
    const env = await client.beta.environments.create({
      name: "assistant-env",
      description: "Песочница Telegram-ассистента: открытый интернет для поиска и чтения сайтов.",
      config,
    });
    state.environment_id = env.id;
    save();
    console.log(`✓ среда создана: ${env.id}`);
  }
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

async function upsertMemory() {
  if (!state.memory_store_id) {
    const store = await client.beta.memoryStores.create({
      name: MEMORY_STORE_NAME,
      description:
        "Постоянная память личного ассистента юриста: профиль пользователя, настройки дайджеста и мониторинга, " +
        "снимки отслеживаемых объектов, журнал отправленного и заметки по темам и делам.",
    });
    state.memory_store_id = store.id;
    save();
    console.log(`✓ память создана: ${store.id}`);
  } else {
    console.log(`✓ память уже есть: ${state.memory_store_id}`);
  }
  const seedDir = path.join(ROOT, "agent/memory");
  for (const file of walk(seedDir)) {
    const memPath = "/" + path.relative(seedDir, file).split(path.sep).join("/");
    try {
      await client.beta.memoryStores.memories.create(state.memory_store_id, {
        path: memPath,
        content: fs.readFileSync(file, "utf8"),
      });
      console.log(`  + ${memPath}`);
    } catch (err) {
      if (err instanceof Anthropic.APIError && err.status === 409) {
        console.log(`  = ${memPath} (уже есть, не трогаю)`);
      } else throw err;
    }
  }
}

function agentBody(name: string, model: string, effort: string, promptFile: string, description: string) {
  return {
    name,
    description,
    model: { id: model, effort: effort as "low" | "medium" | "high" | "xhigh" | "max" },
    system: read(promptFile),
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        default_config: { enabled: true, permission_policy: { type: "auto" as const } },
        configs: [
          { type: "web_search" as const, name: "web_search" as const, enabled: true },
          { type: "web_fetch" as const, name: "web_fetch" as const, enabled: true, max_content_tokens: 12000 },
        ],
      },
    ],
  };
}

const LAWYER = "Личный ассистент юриста в Telegram: ответы с источниками, файлы, дайджест, мониторинг.";
const FAMILY = "Личный помощник для членов семьи в Telegram: ответы, поиск, файлы, своя память.";

async function upsertAgent(
  key: "chat_agent_id" | "scheduled_agent_id" | "family_agent_id",
  name: string,
  model: string,
  effort: string,
  promptFile = "agent/system-prompt.md",
  description = LAWYER,
) {
  const body = agentBody(name, model, effort, promptFile, description);
  const existing = state[key];
  if (existing) {
    const a = await client.beta.agents.update(existing, body);
    console.log(`✓ агент «${name}» обновлён: ${a.id} (версия ${a.version}, ${model})`);
  } else {
    const a = await client.beta.agents.create(body);
    state[key] = a.id;
    save();
    console.log(`✓ агент «${name}» создан: ${a.id} (${model})`);
  }
}

async function upsertDeployment(
  key: "digest_deployment_id" | "monitor_deployment_id",
  name: string,
  cron: string,
  kickoff: string,
  budgetUsd: number,
  kind: string,
) {
  const body = {
    name,
    description: `Telegram-ассистент: ${kind}`,
    agent: state.scheduled_agent_id!,
    environment_id: state.environment_id!,
    initial_events: [{ type: "user.message" as const, content: [{ type: "text" as const, text: read(kickoff) }] }],
    schedule: { type: "cron" as const, expression: cron, timezone: cfg.timezone },
    resources: [memoryResourceFor(state.memory_store_id!)],
    budget: { type: "limit" as const, max_list_cost: { amount: cents(budgetUsd), currency: "USD" as const } },
    metadata: { kind },
  };
  const existing = state[key];
  const d = existing ? await client.beta.deployments.update(existing, body) : await client.beta.deployments.create(body);
  if (!existing) {
    state[key] = d.id;
    save();
  }
  const next = d.schedule?.upcoming_runs_at?.slice(0, 2).join(", ") ?? "—";
  console.log(`✓ расписание «${name}» ${existing ? "обновлено" : "создано"}: ${d.id}; ближайшие запуски: ${next}`);
}

async function main() {
  await checkAccess();
  await upsertEnvironment();
  await upsertMemory();
  await upsertAgent("chat_agent_id", "Ассистент — чат", cfg.chat.model, cfg.chat.effort);
  await upsertAgent("scheduled_agent_id", "Ассистент — расписание", cfg.scheduled.model, cfg.scheduled.effort);
  await upsertAgent("family_agent_id", "Ассистент — семья", cfg.chat.model, cfg.chat.effort, "agent/family-system-prompt.md", FAMILY);
  await upsertDeployment("digest_deployment_id", "Утренний дайджест", cfg.digest.cron, "agent/kickoff-digest.md", cfg.digest.budget_usd, "digest");
  await upsertDeployment("monitor_deployment_id", "Мониторинг", cfg.monitor.cron, "agent/kickoff-monitor.md", cfg.monitor.budget_usd, "monitor");
  save();
  console.log(`\nГотово. ID сохранены в state.json. Посмотреть всё можно в Console: https://platform.claude.com/workspaces/${cfg.workspace}/agents`);
}

main().catch((err) => {
  console.error("\n✗ Ошибка:", err instanceof Error ? err.message : err);
  process.exit(1);
});
