import { App, Env, makeApp } from "./app";
import { handleUpdate } from "./bot";
import { processSession, sweep } from "./sessions";
import type { TgUpdate } from "./telegram";

async function reportError(app: App, err: unknown, where: string) {
  console.error(where, err);
  const owner = await app.db.ownerId().catch(() => null);
  if (!owner) return;
  const text = err instanceof Error ? err.message : String(err);
  await app.tg.sendMessage(owner, `⚠️ Сбой посредника (${where}): ${text.slice(0, 500)}`).catch(() => undefined);
}

async function onDeploymentRunFailed(app: App, runId: string) {
  const owner = await app.db.ownerId();
  if (!owner) return;
  const run = await app.anthropic.beta.deploymentRuns.retrieve(runId);
  const reason = run.error?.message ?? run.error?.type ?? "неизвестная причина";
  await app.tg.sendMessage(owner, `⚠️ Задача по расписанию не запустилась: ${reason}`);
}

export async function handleFetch(req: Request, app: App, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(req.url);
  const { env } = app;

  // 1) Telegram -> посредник
  if (req.method === "POST" && url.pathname === "/telegram") {
    if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TG_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = (await req.json()) as TgUpdate;
    ctx.waitUntil(handleUpdate(app, update).catch((e) => reportError(app, e, "telegram")));
    return new Response("ok");
  }

  // 2) Anthropic -> посредник (сессия закончила ход / завершилась)
  if (req.method === "POST" && url.pathname === "/anthropic") {
    const body = await req.text();
    const key = env.ANTHROPIC_WEBHOOK_SIGNING_KEY || (await app.db.getSetting("webhook_key"));
    let event;
    try {
      // Пока ключ подписи не задан (/key в боте), принимаем без проверки: вебхук
      // содержит только id, а всё содержимое посредник сам читает из API своим ключом.
      event = key
        ? app.anthropic.beta.webhooks.unwrap(body, { headers: Object.fromEntries(req.headers), key })
        : app.anthropic.beta.webhooks.parseUnverified(body);
    } catch {
      return new Response("invalid signature", { status: 400 });
    }
    if (!(await app.db.firstSeen(event.id))) return new Response(null, { status: 204 });

    const type: string = event.data.type;
    if (type === "session.status_idled" || type === "session.status_terminated") {
      ctx.waitUntil(processSession(app, event.data.id).catch((e) => reportError(app, e, "session")));
    } else if (type === "deployment_run.failed") {
      ctx.waitUntil(onDeploymentRunFailed(app, event.data.id).catch((e) => reportError(app, e, "deployment")));
    }
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/") return new Response("claude-assistant: ok");
  return new Response("not found", { status: 404 });
}

export async function handleScheduled(app: App, scheduledTime: number) {
  await sweep(app).catch((e) => console.error("sweep", e));
  if (new Date(scheduledTime).getUTCMinutes() < 2) await app.db.prune().catch(() => undefined);
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(req, makeApp(env), ctx);
  },
  // Каждые 2 минуты: подстраховка на случай потерянного вебхука + чистка
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(makeApp(env), controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
