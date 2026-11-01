import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSessionEventType,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { agentIds, App, consoleUrl, formatCents, memoryResource, sleep } from "./app";
import type { SessionRow } from "./db";
import { familyMemoryResource } from "./constants";
import { escapeHtml } from "./format";

/** Разговор начинается заново, если в чате не было сообщений столько времени. */
const CHAT_IDLE_ROTATE_MS = 12 * 3600_000;
const TG_DOCUMENT_LIMIT = 50 * 1024 * 1024;

const EVENT_TYPES: BetaManagedAgentsSessionEventType[] = [
  "agent.message",
  "agent.tool_use",
  "agent.mcp_tool_use",
  "user.tool_confirmation",
  "session.status_idle",
  "session.status_terminated",
  "session.error",
];

export class UserFacingError extends Error {}

// ---------------------------------------------------------------------------
// Сессии разговора в чате
// ---------------------------------------------------------------------------

/** Какой агент и какая память у этого чата: член семьи — свой агент и своя память. */
async function chatProfile(app: App, chatId: number) {
  const user = await app.db.getUser(chatId);
  if (user?.role === "family" && user.memory_store_id) {
    return { agent: app.env.FAMILY_AGENT_ID, memory: familyMemoryResource(user.memory_store_id), who: user.name ?? "семья" };
  }
  return { agent: app.env.AGENT_ID, memory: memoryResource(app.env), who: user?.name ?? "владелец" };
}

export async function createChatSession(app: App, chatId: number): Promise<string> {
  const stamp = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  const profile = await chatProfile(app, chatId);
  const session = await app.anthropic.beta.sessions.create({
    agent: profile.agent,
    environment_id: app.env.ENVIRONMENT_ID,
    title: `Telegram · ${profile.who} · ${stamp}`,
    metadata: { chat_id: String(chatId), kind: "chat" },
    budget: { type: "limit", max_list_cost: { amount: app.env.CHAT_BUDGET_CENTS || "300", currency: "USD" } },
    resources: [profile.memory],
  });
  await app.db.addSession(session.id, chatId, "chat");
  await app.db.setChatSession(chatId, session.id);
  return session.id;
}

export async function ensureChatSession(app: App, chatId: number): Promise<string> {
  const chat = await app.db.getChat(chatId);
  const stale = !chat || Date.now() - chat.last_activity > CHAT_IDLE_ROTATE_MS;
  if (chat?.session_id && !stale) return chat.session_id;
  return createChatSession(app, chatId);
}

/**
 * Отправляет сообщение в сессию. Если сессия чата закончилась (лимит, ошибка,
 * архив) — тихо начинает новую и отправляет туда. Возвращает id сессии.
 */
export async function sendUserMessage(app: App, sessionId: string, chatId: number, text: string, isChat: boolean): Promise<string> {
  const send = (id: string) =>
    app.anthropic.beta.sessions.events.send(id, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
  try {
    await send(sessionId);
    return sessionId;
  } catch (err) {
    if (!(err instanceof Anthropic.APIError) || !err.status || err.status >= 500 || err.status === 429) throw err;
    let status: string | null = null;
    try {
      const s = await app.anthropic.beta.sessions.retrieve(sessionId);
      status = s.archived_at ? "archived" : s.status;
    } catch {
      status = "missing";
    }
    if (status === "idle" && /requires_action|tool_confirmation|blocked/i.test(err.message)) {
      throw new UserFacingError("Агент ждёт вашего решения по запросу выше — нажмите «Разрешить» или «Запретить».");
    }
    if (!isChat) throw new UserFacingError("Эта задача уже завершена. Напишите обычным сообщением (не ответом) — начнём новый разговор.");
    const fresh = await createChatSession(app, chatId);
    await send(fresh);
    return fresh;
  }
}

// ---------------------------------------------------------------------------
// Пересылка результатов сессии в Telegram
// ---------------------------------------------------------------------------

/** Находит или регистрирует сессию; null — если сессия не нашего агента. */
async function sessionRow(app: App, sessionId: string): Promise<SessionRow | null> {
  const known = await app.db.getSession(sessionId);
  if (known) return known;
  const s = await app.anthropic.beta.sessions.retrieve(sessionId);
  if (!s.agent?.id || !agentIds(app.env).includes(s.agent.id)) return null;
  // Пересылаем только свои сессии: разговоры из Telegram и запуски по расписанию.
  // Пробные и созданные вручную в Console сессии того же агента — не трогаем.
  const kind = s.metadata?.kind;
  const isChat = kind === "chat";
  const isScheduled = !!s.deployment_id || kind === "digest" || kind === "monitor";
  if (!isChat && !isScheduled) return null;
  const chatId = Number(s.metadata?.chat_id) || (await app.db.ownerId());
  if (!chatId) return null;
  await app.db.addSession(sessionId, chatId, isChat ? "chat" : "scheduled");
  return app.db.getSession(sessionId);
}

/** Пересылает новое из сессии в Telegram. true — если ход агента закончен и всё отправлено. */
export async function processSession(app: App, sessionId: string): Promise<boolean> {
  if (!(await sessionRow(app, sessionId))) return false;

  let locked = false;
  for (let i = 0; i < 8 && !(locked = await app.db.lockSession(sessionId)); i++) await sleep(2500);
  if (!locked) return false;

  try {
    const row = (await app.db.getSession(sessionId))!;
    const seen = new Set<string>(JSON.parse(row.cursor_ids) as string[]);
    const events: BetaManagedAgentsSessionEvent[] = [];
    for await (const ev of app.anthropic.beta.sessions.events.list(sessionId, {
      types: EVENT_TYPES,
      order: "asc",
      limit: 100,
      ...(row.cursor_ts ? { "created_at[gte]": row.cursor_ts } : {}),
    })) {
      if (!seen.has(ev.id)) events.push(ev);
    }
    if (!events.length) return false;

    const delivered = await deliver(app, row, events);
    if (!delivered) return false; // ход агента ещё не закончен — дождёмся следующего idle

    let ts = row.cursor_ts ?? "";
    for (const e of events) if (e.processed_at && e.processed_at > ts) ts = e.processed_at;
    const ids = [...(ts === row.cursor_ts ? seen : []), ...events.filter((e) => e.processed_at === ts).map((e) => e.id)];
    await app.db.saveCursor(sessionId, ts, ids);
    return true;
  } finally {
    await app.db.unlockSession(sessionId);
  }
}

function isNoChanges(text: string) {
  const t = text.trim();
  return t === "" || (t.length < 300 && /\bNO_CHANGES\b/.test(t));
}

function describeError(ev: Extract<BetaManagedAgentsSessionEvent, { type: "session.error" }>): string {
  const e = ev.error as { type?: string; message?: string };
  if (e.type === "billing_error") return "закончились средства на балансе Claude Console — пополните его в Settings → Billing";
  return e.message || e.type || "неизвестная ошибка";
}

function toolSummary(input: Record<string, unknown>): string {
  const pick = input.command ?? input.url ?? input.query ?? input.file_path ?? input.path ?? input;
  const s = typeof pick === "string" ? pick : JSON.stringify(pick, null, 1);
  return s.length > 700 ? `${s.slice(0, 700)}…` : s;
}

/** Возвращает false, если ход агента ещё не закончился и пересылать рано. */
async function deliver(app: App, row: SessionRow, events: BetaManagedAgentsSessionEvent[]): Promise<boolean> {
  const { tg, db } = app;
  const chatId = row.chat_id;
  const texts: string[] = [];
  const toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const errors: string[] = [];
  let idle: BetaManagedAgentsSessionStatusIdleEvent | null = null;
  let terminated = false;
  let touchedOutputs = false;

  for (const ev of events) {
    switch (ev.type) {
      case "agent.message": {
        // Ответ с источниками приходит одним событием из нескольких текстовых блоков,
        // разрезанных посреди фразы, — склеиваем их как есть, без разделителя.
        const t = ev.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        if (t) texts.push(t);
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (JSON.stringify(ev.input).includes("/mnt/session/outputs")) touchedOutputs = true;
        toolUses.set(ev.id, { name: ev.name, input: ev.input });
        break;
      case "session.status_idle":
        idle = ev;
        break;
      case "session.status_terminated":
        terminated = true;
        break;
      case "session.error":
        errors.push(describeError(ev));
        break;
    }
  }
  if (!idle && !terminated) return false;

  const stop = idle?.stop_reason;
  const waitingForUser = stop?.type === "requires_action";
  if (row.kind === "chat" && !waitingForUser) {
    const ph = await db.takePlaceholder(chatId);
    if (ph) await tg.deleteMessage(chatId, ph);
  }

  // 1. Текст ответа
  const text = texts.join("\n\n");
  if (!(row.kind === "scheduled" && isNoChanges(text)) && text.trim()) {
    const ids = await tg.sendMarkdown(chatId, text);
    if (row.kind === "scheduled") await db.addRoutes(chatId, ids, row.session_id);
  }

  // 2. Запросы разрешения
  if (stop?.type === "requires_action") {
    for (const eventId of stop.event_ids) {
      const tool = toolUses.get(eventId);
      if (!tool) continue; // уже отправляли раньше
      const id = await db.addConfirmation(row.session_id, eventId, chatId);
      if (!id) continue;
      const msg = await tg.sendButtons(
        chatId,
        `🔐 Агент просит разрешения на действие <b>${escapeHtml(tool.name)}</b>:\n<pre>${escapeHtml(toolSummary(tool.input))}</pre>`,
        [[
          { text: "✅ Разрешить", callback_data: `c:a:${id}` },
          { text: "❌ Запретить", callback_data: `c:d:${id}` },
        ]],
      );
      await db.setConfirmationMessage(id, msg.message_id);
    }
  }

  // 3. Особые причины остановки
  if (stop?.type === "budget_reached") {
    if (row.kind === "chat") {
      await db.clearChatSessionIf(chatId, row.session_id);
      await tg.sendMessage(chatId, `💸 Этот разговор дошёл до лимита ${formatCents(app.env.CHAT_BUDGET_CENTS)}. Следующее сообщение начнёт новый разговор — память сохранится.`);
    } else {
      await tg.sendMessage(chatId, "💸 Задача по расписанию остановилась: достигнут лимит бюджета на один запуск.");
    }
  } else if (stop?.type === "retries_exhausted") {
    await tg.sendMessage(chatId, `⚠️ Агент не смог закончить ответ из-за ошибок сервиса${errors.length ? `: ${errors.at(-1)}` : ""}. Попробуйте ещё раз.`);
  } else if (stop?.type === "refusal") {
    await tg.sendMessage(chatId, "⚠️ Модель отказалась отвечать на этот запрос. Попробуйте переформулировать.");
  } else if (errors.length && !texts.length) {
    await tg.sendMessage(chatId, `⚠️ Ошибка: ${errors.at(-1)}`);
  }

  if (terminated && row.kind === "chat") {
    await db.clearChatSessionIf(chatId, row.session_id);
    await tg.sendMessage(chatId, "Разговор завершён. Следующее сообщение начнёт новый.");
  }

  // 4. Файлы, которые агент положил в /mnt/session/outputs
  if (!waitingForUser) await sendNewFiles(app, row.session_id, chatId, touchedOutputs);
  return true;
}

async function sendNewFiles(app: App, sessionId: string, chatId: number, expectNew: boolean) {
  const attempts = expectNew ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(2500); // файлы индексируются с задержкой 1-3 с
    let sent = 0;
    for await (const f of app.anthropic.beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) {
      if (!(await app.db.markFileSent(f.id, sessionId))) continue;
      try {
        if (f.size_bytes > TG_DOCUMENT_LIMIT) {
          await app.tg.sendMessage(chatId, `📎 Файл ${f.filename} больше 50 МБ — Telegram его не примет. Скачайте его в Console: ${consoleUrl(app.env, sessionId)}`);
        } else {
          const res = await app.anthropic.files.download(f.id);
          await app.tg.sendDocument(chatId, await res.arrayBuffer(), f.filename);
        }
        sent++;
      } catch (err) {
        await app.db.unmarkFileSent(f.id);
        console.error("file relay failed", f.id, err);
      }
    }
    if (sent) return;
  }
}

/**
 * Быстрый путь без вебхука: после сообщения пользователя несколько секунд следим
 * за сессией и сразу пересылаем короткий ответ. Длинные ответы заберёт вебхук или
 * ежеминутный резервный проход.
 */
export async function waitAndDeliver(app: App, sessionId: string, totalMs: number, stepMs = 3000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    await sleep(stepMs);
    const s = await app.anthropic.beta.sessions.retrieve(sessionId);
    if ((s.status === "idle" || s.status === "terminated") && (await processSession(app, sessionId))) return;
  }
}

/** Резервный проход по свежим сессиям — на случай потерянного вебхука. */
export async function sweep(app: App) {
  for (const agentId of agentIds(app.env)) {
    let n = 0;
    for await (const s of app.anthropic.beta.sessions.list({
      agent_id: agentId,
      statuses: ["idle", "terminated"],
      order: "desc",
      limit: 10,
    })) {
      if (++n > 10) break;
      if (Date.now() - Date.parse(s.updated_at) > 30 * 60_000) continue;
      await processSession(app, s.id).catch((e) => console.error("sweep", s.id, e));
    }
  }
}
