import { toFile } from "@anthropic-ai/sdk";
import { App, consoleUrl, formatCents } from "./app";
import { FAMILY_MEMORY_STORE_NAME, familyProfile } from "./constants";
import type { Role, UserRow } from "./db";
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

const OWNER_HELP = `

<b>Доступ</b>
/invite — подключить ваш другой аккаунт или члена семьи
/users — кто подключён
/remove &lt;id&gt; — отключить`;

const FAMILY_HELP = `Я ваш личный помощник на Claude. Просто пишите — отвечу, поищу в интернете, разберу документ или фото, подготовлю файл. Важное запоминаю между разговорами.

<b>Команды</b>
/new — начать новый разговор (память сохранится)
/stop — остановить текущий ответ
/status — расход текущего разговора
/help — эта справка`;

function helpFor(role: Role) {
  if (role === "family") return FAMILY_HELP;
  return role === "owner" ? HELP + OWNER_HELP : HELP;
}

const ROLE_NAMES: Record<Role, string> = { owner: "владелец", self: "ваш аккаунт", family: "семья" };
const INVITE_TTL_MS = 24 * 3600_000;

function displayName(from: { first_name?: string; username?: string; id: number }) {
  return [from.first_name, from.username ? `@${from.username}` : null].filter(Boolean).join(" ") || String(from.id);
}

export async function handleUpdate(app: App, update: TgUpdate) {
  if (update.callback_query) return handleCallback(app, update.callback_query);
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private") return;
  const { tg, db, env } = app;
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();

  const user = await db.getUser(msg.from.id);
  if (!user) {
    const owner = await db.ownerId();
    const code = text.match(/^\/start\s+(\S+)$/)?.[1];
    if (!owner) {
      if (env.PAIR_CODE && code === env.PAIR_CODE) {
        await db.setSetting("owner_id", String(msg.from.id));
        await db.addUser(msg.from.id, "owner", displayName(msg.from), null);
        await tg.sendMessage(chatId, `✅ Бот привязан к вам.\n\n${helpFor("owner")}`, { parse_mode: "HTML" });
      } else if (text.startsWith("/start")) {
        await tg.sendMessage(chatId, "Это частный бот. Чтобы привязать его к себе, отправьте /start и код из инструкции.");
      }
      return;
    }
    // Код приглашения принимаем в любом виде: «/start КОД», просто «КОД», маленькими буквами
    const candidates = [...new Set([...text.toUpperCase().matchAll(/[A-Z0-9]{6,12}/g)].map((m) => m[0]))].slice(0, 3);
    if (candidates.length) {
      for (const c of candidates) if (await acceptInvite(app, msg, c, owner)) return;
      await tg.sendMessage(chatId, "Код не подошёл: он неверный, уже использован или устарел. Попросите новый.");
      return;
    }
    await tg.sendMessage(chatId, "Это частный бот. Если вас пригласили — пришлите код приглашения.");
    return;
  }

  try {
    const cmd = !msg.document && !msg.photo ? text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/) : null;
    if (cmd && (await handleCommand(app, msg, user, cmd[1].toLowerCase(), (cmd[2] ?? "").trim()))) return;
    await forwardToAgent(app, msg, text);
  } catch (err) {
    if (err instanceof UserFacingError) {
      await tg.sendMessage(chatId, err.message);
      return;
    }
    throw err;
  }
}

/** true — если код подошёл и пользователь подключён. */
async function acceptInvite(app: App, msg: TgMessage, code: string, owner: number): Promise<boolean> {
  const { tg, db, anthropic } = app;
  const from = msg.from!;
  const role = await db.takeInvite(code, from.id);
  if (!role) return false;
  const name = displayName(from);
  let memoryStoreId: string | null = null;
  if (role === "family") {
    // У члена семьи — своя память, отдельная от памяти владельца
    const store = await anthropic.beta.memoryStores.create({
      name: FAMILY_MEMORY_STORE_NAME,
      description: `Личная память помощника для ${name}: профиль, предпочтения, заметки.`,
    });
    await anthropic.beta.memoryStores.memories.create(store.id, { path: "/profile.md", content: familyProfile(from.first_name ?? name) });
    memoryStoreId = store.id;
  }
  await db.addUser(from.id, role, name, memoryStoreId);
  await tg.sendMessage(msg.chat.id, `✅ Готово, вы подключены.\n\n${helpFor(role)}`, { parse_mode: "HTML" });
  await tg.sendMessage(owner, `✅ Подключён: ${name} (${ROLE_NAMES[role]}).`);
  return true;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
}

async function handleCommand(app: App, msg: TgMessage, user: UserRow, cmd: string, arg: string): Promise<boolean> {
  const { tg, db, env, anthropic } = app;
  const chatId = msg.chat.id;
  const isOwner = user.role === "owner";
  const isFamily = user.role === "family";
  const ownerOnly = ["key", "invite", "users", "remove"];
  const notForFamily = ["digest", "monitor"];
  if ((ownerOnly.includes(cmd) && !isOwner) || (notForFamily.includes(cmd) && isFamily)) {
    await tg.sendMessage(chatId, "Эта команда доступна только владельцу бота.");
    return true;
  }
  switch (cmd) {
    case "start":
    case "help":
      await tg.sendMessage(chatId, helpFor(user.role), { parse_mode: "HTML" });
      return true;
    case "invite":
      await tg.sendButtons(chatId, "Кого подключаем?", [
        [{ text: "📱 Мой другой аккаунт", callback_data: "inv:self" }],
        [{ text: "👪 Член семьи (своя память)", callback_data: "inv:family" }],
      ]);
      return true;
    case "users": {
      const users = await db.listUsers();
      const lines = users.map((u) => `• ${escapeHtml(u.name ?? "без имени")} — ${ROLE_NAMES[u.role]} — <code>${u.tg_id}</code>`);
      await tg.sendMessage(chatId, `<b>Подключены</b>\n${lines.join("\n")}\n\nОтключить: /remove &lt;id&gt;`, { parse_mode: "HTML" });
      return true;
    }
    case "remove": {
      const id = Number(arg);
      if (!id) {
        await tg.sendMessage(chatId, "Укажите id из /users, например: /remove 123456789");
        return true;
      }
      if (id === user.tg_id) {
        await tg.sendMessage(chatId, "Себя отключить нельзя.");
        return true;
      }
      const removed = await db.removeUser(id);
      await tg.sendMessage(chatId, removed ? "Отключил. Его память и прошлые разговоры остаются в Claude Console." : "Такого пользователя нет.");
      return true;
    }
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

async function handleInviteCallback(app: App, cq: TgCallbackQuery, role: Role) {
  const { tg, db } = app;
  if (cq.from.id !== (await db.ownerId())) return tg.answerCallback(cq.id, "Только владелец может приглашать.");
  const code = randomCode();
  await db.createInvite(code, role, INVITE_TTL_MS);
  const me = await tg.call<{ username: string }>("getMe", {});
  const who = role === "family" ? "члена семьи" : "вашего другого аккаунта";
  const text =
    `Приглашение для ${who} — одноразовое, действует 24 часа.\n\n` +
    `Перешлите эту ссылку на нужный аккаунт и откройте её там, затем нажмите «Запустить»:\n` +
    `https://t.me/${me.username}?start=${code}\n\n` +
    `Или откройте @${me.username} с нужного аккаунта и отправьте код: <code>${code}</code>` +
    (role === "family" ? "\n\nУ члена семьи будет свой помощник и своя память — ваших заметок он не увидит." : "");
  if (cq.message) await tg.editText(cq.message.chat.id, cq.message.message_id, text).catch(() => tg.sendMessage(cq.from.id, text, { parse_mode: "HTML" }));
  else await tg.sendMessage(cq.from.id, text, { parse_mode: "HTML" });
  return tg.answerCallback(cq.id);
}

async function handleCallback(app: App, cq: TgCallbackQuery) {
  const { tg, db, anthropic } = app;
  const inv = cq.data?.match(/^inv:(self|family)$/);
  if (inv) return handleInviteCallback(app, cq, inv[1] as Role);
  const m = cq.data?.match(/^c:([ad]):(\d+)$/);
  if (!m) return tg.answerCallback(cq.id);

  // Разрешать действие может тот, чей это разговор, или владелец
  const pending = await db.getConfirmation(Number(m[2]));
  if (!pending) return tg.answerCallback(cq.id, "Запрос не найден.");
  if (cq.from.id !== pending.chat_id && cq.from.id !== (await db.ownerId())) return tg.answerCallback(cq.id, "Это не ваш запрос.");

  const result = m[1] === "a" ? "allow" : "deny";
  const row = await db.resolveConfirmation(pending.id, result);
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
