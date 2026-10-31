// Пробный разговор с агентом без Telegram: проверяет память, поиск и инструменты.
//   ASSISTANT_API_KEY=... npx tsx scripts/smoke.ts "вопрос"
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { memoryResourceFor } from "../src/constants";

const ROOT = path.resolve(import.meta.dirname, "..");
const state = JSON.parse(fs.readFileSync(path.join(ROOT, "state.json"), "utf8"));
const client = new Anthropic({ apiKey: process.env.ASSISTANT_API_KEY });
const question =
  process.argv[2] ??
  "Проверка связи. 1) Прочитай profile.md из памяти и одной фразой скажи, кто я. 2) Найди одну новость за последние 7 дней по миграционному праву РФ и дай её с датой и ссылкой. 3) Проверь, открываются ли из песочницы publication.pravo.gov.ru и kad.arbitr.ru (curl, код ответа). Ответ — до 8 строк.";

const session = await client.beta.sessions.create({
  agent: state.chat_agent_id,
  environment_id: state.environment_id,
  title: "Smoke test",
  metadata: { kind: "smoke" },
  budget: { type: "limit", max_list_cost: { amount: "50", currency: "USD" } },
  resources: [memoryResourceFor(state.memory_store_id)],
});
console.log(`session: https://platform.claude.com/workspaces/default/sessions/${session.id}\n`);

const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: question }] }],
});

for await (const ev of stream) {
  if (ev.type === "agent.message") {
    for (const b of ev.content) if (b.type === "text") console.log(`\n[ответ]\n${b.text}\n`);
  } else if (ev.type === "agent.tool_use") {
    console.log(`[инструмент] ${ev.name} ${JSON.stringify(ev.input).slice(0, 160)} (${ev.evaluated_permission})`);
    if (ev.evaluated_permission === "ask") {
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.tool_confirmation", tool_use_id: ev.id, result: "deny", deny_message: "Пробный запуск: без подтверждений." }],
      });
    }
  } else if (ev.type === "session.error") {
    console.log("[ошибка]", JSON.stringify(ev.error));
  } else if (ev.type === "session.status_idle") {
    if (ev.stop_reason.type !== "requires_action") {
      console.log(`[стоп] ${ev.stop_reason.type}`);
      break;
    }
  } else if (ev.type === "session.status_terminated") {
    console.log("[завершено]");
    break;
  }
}
const final = await client.beta.sessions.retrieve(session.id);
console.log(`\nстоимость: $${(Number(final.usage?.list_cost?.amount ?? 0) / 100).toFixed(2)}, активное время: ${final.usage?.active_seconds ?? "?"} с`);
