import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { handleUpdate } from "../src/bot";
import { handleFetch, handleScheduled } from "../src/index";
import { processSession, waitAndDeliver } from "../src/sessions";
import type { TgUpdate } from "../src/telegram";
import { installFakeTelegram, makeTestApp } from "./fakes";

const OWNER = 555;
let tg: ReturnType<typeof installFakeTelegram>;
beforeEach(() => (tg = installFakeTelegram()));
afterEach(() => tg.restore());

let upd = 1;
const text = (t: string, extra: Record<string, unknown> = {}, from = OWNER): TgUpdate => ({
  update_id: upd++,
  message: { message_id: upd + 10_000, from: { id: from }, chat: { id: from, type: "private" }, date: 0, text: t, ...extra },
});

async function paired() {
  const t = makeTestApp();
  await handleUpdate(t.app, text("/start 424242"));
  tg.calls.length = 0;
  return t;
}

test("привязка: чужой код не подходит, правильный — привязывает; чужих не пускает", async () => {
  const { app } = makeTestApp();
  await handleUpdate(app, text("/start 000000"));
  assert.equal(await app.db.ownerId(), null);
  assert.match(String(tg.sent().at(-1)!.body.text), /частный бот/);

  await handleUpdate(app, text("/start 424242"));
  assert.equal(await app.db.ownerId(), OWNER);
  assert.match(String(tg.sent().at(-1)!.body.text), /привязан/);

  await handleUpdate(app, text("привет", {}, 999));
  assert.match(String(tg.sent().at(-1)!.body.text), /частный бот/);
});

test("сообщение -> сессия с памятью и бюджетом -> ответ агента в Telegram, без дублей", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("Что нового по патентам?"));

  assert.equal(anthropic.created.length, 1);
  const created = anthropic.created[0] as Record<string, any>;
  assert.equal(created.agent, "agent_chat");
  assert.deepEqual(created.metadata, { chat_id: String(OWNER), kind: "chat" });
  assert.equal(created.budget.max_list_cost.amount, "300");
  assert.equal(created.resources[0].type, "memory_store");
  const sid = [...anthropic.sessions.keys()][0];
  assert.deepEqual(anthropic.sent[0].events[0], { type: "user.message", content: [{ type: "text", text: "Что нового по патентам?" }] });
  const placeholder = tg.sent().find((c) => c.body.text === "⏳ Думаю…");
  assert.ok(placeholder);

  // агент ответил
  anthropic.push(sid, { type: "agent.tool_use", name: "web_search", input: { query: "патенты" }, evaluated_permission: "allow" });
  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "**Главное**: с 1 января меняется размер авансового платежа." }] });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, sid);

  assert.ok(tg.calls.some((c) => c.method === "deleteMessage"), "плашка «Думаю» удалена");
  const answer = tg.sent().at(-1)!;
  assert.equal(answer.body.parse_mode, "HTML");
  assert.equal(answer.body.text, "<b>Главное</b>: с 1 января меняется размер авансового платежа.");

  const before = tg.sent().length;
  await processSession(app, sid);
  assert.equal(tg.sent().length, before, "повторная обработка ничего не дублирует");

  // второе сообщение идёт в ту же сессию
  await handleUpdate(app, text("А для Казахстана?"));
  assert.equal(anthropic.created.length, 1);
  assert.equal(anthropic.sent.at(-1)!.sessionId, sid);
});

test("ход не закончен — ничего не шлём; закончился — шлём всё разом", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("вопрос"));
  const sid = [...anthropic.sessions.keys()][0];
  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "часть 1" }] });
  await processSession(app, sid);
  assert.ok(!tg.sent().some((c) => c.body.text === "часть 1"));
  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "часть 2" }] });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, sid);
  assert.equal(tg.sent().at(-1)!.body.text, "часть 1\n\nчасть 2");
});

test("ответ из нескольких блоков (вокруг источников) склеивается без разрывов", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("новости?"));
  const sid = [...anthropic.sessions.keys()][0];
  anthropic.push(sid, {
    type: "agent.message",
    content: [
      { type: "text", text: "С 25.10 СФР передаёт данные в МВД. Об этом пишет ГАРАНТ.РУ: " },
      { type: "text", text: "передача идёт через СМЭВ" },
      { type: "text", text: ". [ГАРАНТ.РУ](https://www.garant.ru/news/1/)" },
    ],
  });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, sid);
  assert.equal(
    tg.sent().at(-1)!.body.text,
    'С 25.10 СФР передаёт данные в МВД. Об этом пишет ГАРАНТ.РУ: передача идёт через СМЭВ. <a href="https://www.garant.ru/news/1/">ГАРАНТ.РУ</a>',
  );
});

test("запрос разрешения: кнопки -> нажатие -> user.tool_confirmation", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("удали временные файлы"));
  const sid = [...anthropic.sessions.keys()][0];
  const ask = anthropic.push(sid, { type: "agent.tool_use", name: "bash", input: { command: "rm -rf /workspace/tmp" }, evaluated_permission: "ask" });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [ask.id] }, stop_details: null });
  await processSession(app, sid);

  const btn = tg.sent().at(-1)!;
  assert.match(String(btn.body.text), /разрешения.*bash/s);
  assert.match(String(btn.body.text), /rm -rf/);
  const data = (btn.body.reply_markup as any).inline_keyboard[0][0].callback_data as string;
  assert.match(data, /^c:a:\d+$/);
  assert.ok(!tg.calls.some((c) => c.method === "deleteMessage"), "плашку не удаляем, пока агент ждёт");

  await handleUpdate(app, { update_id: upd++, callback_query: { id: "cq1", from: { id: OWNER }, data, message: { message_id: 1, chat: { id: OWNER, type: "private" }, date: 0, text: "🔐 запрос" } } });
  assert.deepEqual(anthropic.sent.at(-1), { sessionId: sid, events: [{ type: "user.tool_confirmation", tool_use_id: ask.id, result: "allow" }] });
  assert.ok(tg.calls.some((c) => c.method === "editMessageText" && String(c.body.text).includes("Разрешено")));

  // повторное нажатие не шлёт второе подтверждение
  const n = anthropic.sent.length;
  await handleUpdate(app, { update_id: upd++, callback_query: { id: "cq2", from: { id: OWNER }, data } });
  assert.equal(anthropic.sent.length, n);
});

test("расписание: NO_CHANGES молчит; отчёт приходит; ответ на него продолжает ту же сессию", async () => {
  const { app, anthropic } = await paired();
  anthropic.addSession("sesn_mon1", "agent_sched", { kind: "monitor" }, { deployment_id: "depl_monitor" });
  anthropic.push("sesn_mon1", { type: "agent.message", content: [{ type: "text", text: "NO_CHANGES" }] });
  anthropic.push("sesn_mon1", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, "sesn_mon1");
  assert.equal(tg.sent().length, 0);

  anthropic.addSession("sesn_dig1", "agent_sched", { kind: "digest" }, { deployment_id: "depl_digest" });
  anthropic.push("sesn_dig1", { type: "agent.message", content: [{ type: "text", text: "🗞 Дайджест на 1 ноября\n\n- **Новый закон**" }] });
  anthropic.push("sesn_dig1", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, "sesn_dig1");
  const digestMsg = tg.sent().at(-1)!;
  assert.match(String(digestMsg.body.text), /Дайджест/);
  assert.equal(digestMsg.body.chat_id, OWNER, "задачи по расписанию идут владельцу");

  // reply на дайджест
  const routedRow = await (app.env.DB as any).prepare("SELECT message_id FROM routes WHERE session_id = ?").bind("sesn_dig1").first();
  assert.ok(routedRow, "сообщение дайджеста запомнено для ответов");
  await handleUpdate(app, text("подробнее про закон", { reply_to_message: { message_id: routedRow.message_id, chat: { id: OWNER, type: "private" }, date: 0 } }));
  assert.equal(anthropic.sent.at(-1)!.sessionId, "sesn_dig1");
  assert.equal(anthropic.created.length, 0, "новая сессия не создаётся");
});

test("чужие сессии (другой агент) игнорируются", async () => {
  const { app, anthropic } = await paired();
  anthropic.addSession("sesn_other", "agent_someone_else");
  anthropic.push("sesn_other", { type: "agent.message", content: [{ type: "text", text: "секрет" }] });
  anthropic.push("sesn_other", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, "sesn_other");
  assert.equal(tg.sent().length, 0);
});

test("лимит бюджета: предупреждаем и следующее сообщение начинает новую сессию", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("первый"));
  const sid = [...anthropic.sessions.keys()][0];
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "budget_reached" }, stop_details: null });
  await processSession(app, sid);
  assert.match(String(tg.sent().at(-1)!.body.text), /лимита \$3\.00/);
  await handleUpdate(app, text("второй"));
  assert.equal(anthropic.created.length, 2);
  assert.notEqual(anthropic.sent.at(-1)!.sessionId, sid);
});

test("сессия закончилась на стороне Anthropic — сообщение уходит в новую", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("первый"));
  const sid = [...anthropic.sessions.keys()][0];
  anthropic.sessions.get(sid)!.status = "terminated";
  anthropic.sendFailures.push(new Anthropic.BadRequestError(400, undefined, "session is terminated", new Headers()));
  await handleUpdate(app, text("второй"));
  assert.equal(anthropic.created.length, 2);
  assert.equal(anthropic.sent.at(-1)!.events[0].type, "user.message");
  assert.notEqual(anthropic.sent.at(-1)!.sessionId, sid);
});

test("файлы: входящий документ монтируется в сессию; файлы из outputs приходят документом один раз", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("", { caption: "Что в договоре?", document: { file_id: "tgf1", file_name: "Договор аренды.pdf", file_size: 10 } }));
  const sid = [...anthropic.sessions.keys()][0];
  const added = anthropic.resourcesAdded[0];
  assert.equal(added.sessionId, sid);
  assert.match(String(added.params.mount_path), /^\/[a-z0-9]+-Договор_аренды\.pdf$/);
  const msg = anthropic.sent.at(-1)!.events[0] as any;
  assert.match(msg.content[0].text, /\/mnt\/session\/uploads\/[a-z0-9]+-Договор_аренды\.pdf/);
  assert.match(msg.content[0].text, /Что в договоре\?/);

  anthropic.push(sid, { type: "agent.tool_use", name: "write", input: { file_path: "/mnt/session/outputs/Разбор.docx", content: "…" }, evaluated_permission: "allow" });
  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "Разбор во вложении." }] });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  anthropic.outputFiles.push({ id: "file_out1", filename: "Разбор.docx", size_bytes: 11, scope: sid });
  await processSession(app, sid);
  const docs = tg.calls.filter((c) => c.method === "sendDocument");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body.document, "<file Разбор.docx>");

  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "ещё" }] });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, sid);
  assert.equal(tg.calls.filter((c) => c.method === "sendDocument").length, 1, "тот же файл второй раз не шлём");
});

test("команды: /digest, /monitor, /new, /status, /key", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("/digest"));
  await handleUpdate(app, text("/monitor"));
  assert.deepEqual(anthropic.runs, ["depl_digest", "depl_monitor"]);

  await handleUpdate(app, text("привет"));
  await handleUpdate(app, text("/status"));
  assert.match(String(tg.sent().at(-1)!.body.text), /<b>\$0\.37<\/b> из \$3\.00/);

  await handleUpdate(app, text("/new"));
  await handleUpdate(app, text("снова привет"));
  assert.equal(anthropic.created.length, 2);

  await handleUpdate(app, text("/key whsec_abc"));
  assert.equal(await app.db.getSetting("webhook_key"), "whsec_abc");
  assert.ok(tg.calls.some((c) => c.method === "deleteMessage"), "сообщение с ключом удалено");
});

test("неправильная разметка от Telegram — откат на простой текст", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("вопрос"));
  const sid = [...anthropic.sessions.keys()][0];
  anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "<broken> ответ" }] });
  anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await processSession(app, sid);
  const last = tg.sent().at(-1)!;
  assert.equal(last.body.parse_mode, undefined);
  assert.equal(last.body.text, "<broken> ответ");
});

// ---------------- HTTP-маршруты Worker ----------------

function sign(secret: string, id: string, ts: string, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

test("маршрут /telegram проверяет секрет", async () => {
  const { app } = makeTestApp();
  const waits: Promise<unknown>[] = [];
  const bad = await handleFetch(new Request("https://w/telegram", { method: "POST", body: "{}" }), app, { waitUntil: (p) => waits.push(p) });
  assert.equal(bad.status, 403);
  const ok = await handleFetch(
    new Request("https://w/telegram", { method: "POST", body: JSON.stringify(text("/start 424242")), headers: { "x-telegram-bot-api-secret-token": "tgsecret" } }),
    app,
    { waitUntil: (p) => waits.push(p) },
  );
  assert.equal(ok.status, 200);
  await Promise.all(waits);
  assert.equal(await app.db.ownerId(), OWNER);
});

test("маршрут /anthropic: подпись проверяется, дубли отсекаются, idle -> пересылка", async () => {
  const { app, anthropic } = await paired();
  const secret = "whsec_" + Buffer.from(crypto.randomBytes(32)).toString("base64");
  await app.db.setSetting("webhook_key", secret);
  anthropic.addSession("sesn_w", "agent_chat", { chat_id: String(OWNER), kind: "chat" });
  anthropic.push("sesn_w", { type: "agent.message", content: [{ type: "text", text: "ответ по вебхуку" }] });
  anthropic.push("sesn_w", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });

  const body = JSON.stringify({ type: "event", id: "whe_1", created_at: new Date().toISOString(), data: { type: "session.status_idled", id: "sesn_w", organization_id: "o", workspace_id: "w" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

  const forged = await handleFetch(new Request("https://w/anthropic", { method: "POST", body, headers: { "webhook-id": "whe_1", "webhook-timestamp": ts, "webhook-signature": "v1,AAAA" } }), app, ctx);
  assert.equal(forged.status, 400);

  const headers = { "webhook-id": "whe_1", "webhook-timestamp": ts, "webhook-signature": sign(secret, "whe_1", ts, body) };
  const ok = await handleFetch(new Request("https://w/anthropic", { method: "POST", body, headers }), app, ctx);
  assert.equal(ok.status, 204);
  await Promise.all(waits);
  assert.equal(tg.sent().at(-1)!.body.text, "ответ по вебхуку");

  const dup = await handleFetch(new Request("https://w/anthropic", { method: "POST", body, headers }), app, ctx);
  assert.equal(dup.status, 204);
  await Promise.all(waits);
  assert.equal(tg.sent().filter((c) => c.body.text === "ответ по вебхуку").length, 1);
});

test("резервный опрос по расписанию Worker находит пропущенный ответ", async () => {
  const { app, anthropic } = await paired();
  anthropic.addSession("sesn_lost", "agent_sched", {}, { deployment_id: "depl_digest" });
  anthropic.push("sesn_lost", { type: "agent.message", content: [{ type: "text", text: "потерянный дайджест" }] });
  anthropic.push("sesn_lost", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await handleScheduled(app, Date.now());
  assert.equal(tg.sent().at(-1)!.body.text, "потерянный дайджест");
});

test("пробные и ручные сессии того же агента не пересылаются", async () => {
  const { app, anthropic } = await paired();
  anthropic.addSession("sesn_smoke", "agent_chat", { kind: "smoke" });
  anthropic.push("sesn_smoke", { type: "agent.message", content: [{ type: "text", text: "пробный ответ" }] });
  anthropic.push("sesn_smoke", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  anthropic.addSession("sesn_console", "agent_sched", {});
  anthropic.push("sesn_console", { type: "agent.message", content: [{ type: "text", text: "из Console" }] });
  anthropic.push("sesn_console", { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  await handleScheduled(app, Date.now());
  assert.equal(tg.sent().length, 0);
});

test("быстрый путь: короткий ответ забирается сразу, не дожидаясь резервного прохода", async () => {
  const { app, anthropic } = await paired();
  await handleUpdate(app, text("быстрый вопрос"));
  const sid = [...anthropic.sessions.keys()][0];
  // ответ появляется чуть позже, чем начинается ожидание
  setTimeout(() => {
    anthropic.push(sid, { type: "agent.message", content: [{ type: "text", text: "быстрый ответ" }] });
    anthropic.push(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" }, stop_details: null });
  }, 60);
  const t0 = Date.now();
  await waitAndDeliver(app, sid, 2000, 20);
  assert.ok(Date.now() - t0 < 1000, "вернулся сразу после доставки");
  assert.equal(tg.sent().at(-1)!.body.text, "быстрый ответ");
});
