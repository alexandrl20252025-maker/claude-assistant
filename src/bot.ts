import { toFile } from "@anthropic-ai/sdk";
import { App, consoleUrl, formatCents } from "./app";
import { escapeHtml } from "./format";
import { createChatSession, ensureChatSession, sendUserMessage, UserFacingError, waitAndDeliver } from "./sessions";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "./telegram";

const HELP = `Я ваш ассистент на Claude. Просто пишите — отвечу, поищу в интернете, разберу документ.

<b>Что умею</b>
• Отвечать на вопросы и искать информацию с источниками
• Анализировать файлы: PDF, Word, Excel, CSV, фото — пришлите файл с вопросом в подписи
• Готовить документы и таблицы — пришлю файлом
• Каждое утро в 8:00 (МСК) — дайджест
• По будням в 10:00 и 17:00 — мониторинг: пишу только если что-то изменилось
• Помнить важное между разговорами

<b>Настройка — обычными словами</b>
«добавь в дайджест тему …», «следи за делом А40-12345/2026», «следи за ценой на … по ссылке …», «что у тебя в памяти?»

<b>Команды</b>
/new — начать новый разговор (память сохранится)
/digest — прислать дайджест сейчас
/monitor — проверить мониторинг сейчас
/stop — остановить текущий ответ
/status — расход текущего разговора
/help — эта справка

Ответ на сообщение дайджеста или мониторинга (reply) продолжает именно ту задачу.`;

export async function handleUpdate(app: App, update: TgUpdate) {
  if (update.callback_query) return handleCallback(app, update.callback_query);
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private") return;
  const { tg, db, env } = app;
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();

  const owner = await db.ownerId();
  if (!owner) {
    if (env.PAIR_CODE && text === `/start ${env.PAIR_CODE}`) {
      await db.setSetting("owner_id", String(msg.from.id));
      await tg.sendMessage(chatId, `✅ Бот привязан к вам.\n\n${HELP}`, { parse_mode: "HTML" });
    } else if (text.startsWith("/start")) {
      await tg.sendMessage(chatId, "Это частный бот. Чтобы привязать его к себе, отправьте /start и код из инструкции.");
    }
    return;
  }
  if (msg.from.id !== owner) {
    await tg.sendMessage(chatId, "Это частный бот.");
    return;
  }

  try {
    const cmd = !msg.document && !msg.photo ? text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/) : null;
    if (cmd && (await handleCommand(app, msg, cmd[1].toLowerCase(), (cmd[2] ?? "").trim()))) return;
    await forwardToAgent(app, msg, text);
  } catch (err) {
    if (err instanceof UserFacingError) {
      await tg.sendMessage(chatId, err.message);
      return;
    }
    throw err;
  }
}

async function handleCommand(app: App, msg: TgMessage, cmd: string, arg: string): Promise<boolean> {
  const { tg, db, env, anthropic } = app;
  const chatId = msg.chat.id;
  switch (cmd) {
    case "start":
    case "help":
      await tg.sendMessage(chatId, HELP, { parse_mode: "HTML" });
      return true;
    case "new":
      await db.setChatSession(chatId, null);
      await tg.sendMessage(chatId, "🆕 Начинаю новый разговор. Всё важное я помню — память сохраняется.");
      return true;
    case "stop": {
      const chat = await db.getChat(chatId);
      if (chat?.session_id) {
        await anthropic.beta.sessions.events.send(chat.session_id, { events: [{ type: "user.interrupt" }] });
        const ph = await db.takePlaceholder(chatId);
        if (ph) await tg.deleteMessage(chatId, ph);
      }
      await tg.sendMessage(chatId, "⏹ Остановил.");
      return true;
    }
    case "digest":
      await anthropic.beta.deployments.run(env.DIGEST_DEPLOYMENT_ID);
      await tg.sendMessage(chatId, "🗞 Запустил дайджест — пришлю через несколько минут.");
      return true;
    case "monitor":
      await anthropic.beta.deployments.run(env.MONITOR_DEPLOYMENT_ID);
      await tg.sendMessage(chatId, "🔎 Запустил проверку. Если изменений нет — промолчу, если есть — напишу.");
      return true;
    case "status": {
      const chat = await db.getChat(chatId);
      if (!chat?.session_id) {
        await tg.sendMessage(chatId, "Сейчас нет активного разговора.");
        return true;
      }
      const s = await anthropic.beta.sessions.retrieve(chat.session_id);
      const spent = formatCents(s.usage?.list_cost?.amount);
      const cap = s.budget ? formatCents(s.budget.max_list_cost.amount) : "без лимита";
      await tg.sendMessage(
        chatId,
        `Текущий разговор: потрачено <b>${spent}</b> из ${cap}.\nСтатус: ${escapeHtml(s.status)}\n<a href="${consoleUrl(env, s.id)}">Открыть в Console</a>`,
        { parse_mode: "HTML" },
      );
      return true;
    }
    case "key":
      if (!arg.startsWith("whsec_")) {
        await tg.sendMessage(chatId, "Пришлите так: /key whsec_… (ключ подписи вебхука из Claude Console).");
        return true;
      }
      await db.setSetting("webhook_key", arg);
      await tg.deleteMessage(chatId, msg.message_id);
      await tg.sendMessage(chatId, "🔑 Ключ подписи сохранил, сообщение с ключом удалил. Теперь ответы будут приходить сразу.");
      return true;
    case "memory":
      await forwardToAgent(app, msg, "Покажи кратко, что сейчас лежит в твоей памяти: по каждому файлу одна-две строки.");
      return true;
    default:
      return false; // неизвестная команда — пусть разбирается агент
  }
}

function pickAttachment(msg: TgMessage): { fileId: string; name: string; size?: number } | null {
  if (msg.document) return { fileId: msg.document.file_id, name: msg.document.file_name ?? "document", size: msg.document.file_size };
  if (msg.photo?.length) {
    const best = msg.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    return { fileId: best.file_id, name: "photo.jpg", size: best.file_size };
  }
  if (msg.audio) return { fileId: msg.audio.file_id, name: msg.audio.file_name ?? "audio", size: msg.audio.file_size };
  if (msg.video) return { fileId: msg.video.file_id, name: msg.video.file_name ?? "video.mp4", size: msg.video.file_size };
  return null;
}

function safeName(name: string) {
  const cleaned = name.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "file").slice(-80);
}

async function forwardToAgent(app: App, msg: TgMessage, text: string) {
  const { tg, db, anthropic } = app;
  const chatId = msg.chat.id;

  if (msg.voice) {
    await tg.sendMessage(chatId, "Голосовые пока не понимаю — напишите, пожалуйста, текстом.");
    return;
  }

  // Ответ (reply) на сообщение дайджеста/мониторинга — продолжаем ту задачу
  const routed = msg.reply_to_message ? await db.routeFor(chatId, msg.reply_to_message.message_id) : null;
  let sessionId = routed ?? (await ensureChatSession(app, chatId));

  let prompt = text;
  const att = pickAttachment(msg);
  if (att) {
    if (att.size && att.size > 20 * 1024 * 1024) {
      await tg.sendMessage(chatId, "Файл больше 20 МБ — Telegram не даёт ботам скачивать такие. Сожмите файл или пришлите частями.");
      return;
    }
    await tg.typing(chatId);
    const { data } = await tg.downloadFile(att.fileId);
    const name = safeName(att.name);
    const uploaded = await anthropic.files.upload({ file: await toFile(data, name) });
    const mount = `/${Date.now().toString(36)}-${name}`;
    try {
      await anthropic.beta.sessions.resources.add(sessionId, { type: "file", file_id: uploaded.id, mount_path: mount });
    } catch (err) {
      if (routed) throw err;
      // сессия могла закончиться — новая сессия и повтор
      sessionId = await createChatSession(app, chatId);
      await anthropic.beta.sessions.resources.add(sessionId, { type: "file", file_id: uploaded.id, mount_path: mount });
    }
    prompt = `[Пользователь прислал файл: /mnt/session/uploads${mount}]\n\n${text || "Посмотри файл и скажи, что в нём главное."}`;
  }
  if (!prompt) return;

  const placeholder = routed ? null : await tg.sendMessage(chatId, "⏳ Думаю…").catch(() => null);
  if (routed) await tg.typing(chatId);
  try {
    sessionId = await sendUserMessage(app, sessionId, chatId, prompt, !routed);
  } catch (err) {
    if (placeholder) await tg.deleteMessage(chatId, placeholder.message_id);
    throw err;
  }
  if (!routed) await db.touchChat(chatId, placeholder?.message_id ?? null);

  // Пока вебхук Anthropic не подключён (/key), короткие ответы забираем сами
  const quickMs = Number(app.env.QUICK_POLL_SECONDS ?? "25") * 1000;
  if (quickMs > 0 && !(await db.getSetting("webhook_key")) && !app.env.ANTHROPIC_WEBHOOK_SIGNING_KEY) {
    await waitAndDeliver(app, sessionId, quickMs);
  }
}

async function handleCallback(app: App, cq: TgCallbackQuery) {
  const { tg, db, anthropic } = app;
  const m = cq.data?.match(/^c:([ad]):(\d+)$/);
  if (!m) return tg.answerCallback(cq.id);
  if (cq.from.id !== (await db.ownerId())) return tg.answerCallback(cq.id, "Это частный бот.");

  const result = m[1] === "a" ? "allow" : "deny";
  const row = await db.resolveConfirmation(Number(m[2]), result);
  if (!row) return tg.answerCallback(cq.id, "Уже обработано.");
  try {
    await anthropic.beta.sessions.events.send(row.session_id, {
      events: [
        result === "allow"
          ? { type: "user.tool_confirmation", tool_use_id: row.event_id, result: "allow" }
          : { type: "user.tool_confirmation", tool_use_id: row.event_id, result: "deny", deny_message: "Пользователь запретил это действие в Telegram." },
      ],
    });
  } catch (err) {
    await db.reopenConfirmation(row.id);
    return tg.answerCallback(cq.id, `Не получилось: ${err instanceof Error ? err.message.slice(0, 150) : "ошибка"}`);
  }
  if (cq.message) {
    const verdict = result === "allow" ? "✅ Разрешено" : "❌ Запрещено";
    await tg.editText(cq.message.chat.id, cq.message.message_id, `${escapeHtml(cq.message.text ?? "")}\n\n${verdict}`).catch(() => undefined);
  }
  return tg.answerCallback(cq.id, result === "allow" ? "Разрешено" : "Запрещено");
}
