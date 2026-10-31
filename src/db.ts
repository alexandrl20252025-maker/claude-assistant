export interface ChatRow {
  chat_id: number;
  session_id: string | null;
  placeholder_message_id: number | null;
  last_activity: number;
}

export interface SessionRow {
  session_id: string;
  chat_id: number;
  kind: "chat" | "scheduled";
  cursor_ts: string | null;
  cursor_ids: string;
  lock_until: number;
  created_at: number;
}

export interface ConfirmationRow {
  id: number;
  session_id: string;
  event_id: string;
  chat_id: number;
  message_id: number | null;
  status: string;
}

const now = () => Date.now();

export class Db {
  constructor(private d1: D1Database) {}

  async getSetting(key: string): Promise<string | null> {
    const row = await this.d1.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.d1
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  async ownerId(): Promise<number | null> {
    const v = await this.getSetting("owner_id");
    return v ? Number(v) : null;
  }

  getChat(chatId: number) {
    return this.d1.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(chatId).first<ChatRow>();
  }

  async setChatSession(chatId: number, sessionId: string | null) {
    await this.d1
      .prepare(
        `INSERT INTO chats (chat_id, session_id, last_activity) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, last_activity = excluded.last_activity`,
      )
      .bind(chatId, sessionId, now())
      .run();
  }

  async clearChatSessionIf(chatId: number, sessionId: string) {
    await this.d1.prepare("UPDATE chats SET session_id = NULL WHERE chat_id = ? AND session_id = ?").bind(chatId, sessionId).run();
  }

  async touchChat(chatId: number, placeholderId: number | null) {
    await this.d1
      .prepare("UPDATE chats SET last_activity = ?, placeholder_message_id = ? WHERE chat_id = ?")
      .bind(now(), placeholderId, chatId)
      .run();
  }

  /** Забирает id «⏳»-сообщения, чтобы удалить его ровно один раз. */
  async takePlaceholder(chatId: number): Promise<number | null> {
    // RETURNING в SQLite отдаёт значение ПОСЛЕ обновления, поэтому сначала читаем,
    // потом условно обнуляем: удалить сообщение должен только тот, кто обнулил.
    const row = await this.d1.prepare("SELECT placeholder_message_id AS id FROM chats WHERE chat_id = ?").bind(chatId).first<{ id: number | null }>();
    if (!row?.id) return null;
    const res = await this.d1
      .prepare("UPDATE chats SET placeholder_message_id = NULL WHERE chat_id = ? AND placeholder_message_id = ?")
      .bind(chatId, row.id)
      .run();
    return (res.meta.changes ?? 0) > 0 ? row.id : null;
  }

  getSession(sessionId: string) {
    return this.d1.prepare("SELECT * FROM sessions WHERE session_id = ?").bind(sessionId).first<SessionRow>();
  }

  async addSession(sessionId: string, chatId: number, kind: SessionRow["kind"]) {
    await this.d1
      .prepare("INSERT OR IGNORE INTO sessions (session_id, chat_id, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(sessionId, chatId, kind, now())
      .run();
  }

  /** Короткая блокировка, чтобы два вебхука не переслали одно и то же дважды. */
  async lockSession(sessionId: string, ms = 45_000): Promise<boolean> {
    const t = now();
    const res = await this.d1
      .prepare("UPDATE sessions SET lock_until = ? WHERE session_id = ? AND lock_until < ?")
      .bind(t + ms, sessionId, t)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async unlockSession(sessionId: string) {
    await this.d1.prepare("UPDATE sessions SET lock_until = 0 WHERE session_id = ?").bind(sessionId).run();
  }

  async saveCursor(sessionId: string, ts: string, ids: string[]) {
    await this.d1
      .prepare("UPDATE sessions SET cursor_ts = ?, cursor_ids = ? WHERE session_id = ?")
      .bind(ts, JSON.stringify(ids), sessionId)
      .run();
  }

  /** true, если вебхук с таким id пришёл впервые. */
  async firstSeen(webhookId: string): Promise<boolean> {
    const res = await this.d1.prepare("INSERT OR IGNORE INTO seen_webhooks (id, at) VALUES (?, ?)").bind(webhookId, now()).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async addRoutes(chatId: number, messageIds: number[], sessionId: string) {
    if (!messageIds.length) return;
    await this.d1.batch(
      messageIds.map((id) =>
        this.d1
          .prepare("INSERT OR REPLACE INTO routes (chat_id, message_id, session_id, at) VALUES (?, ?, ?, ?)")
          .bind(chatId, id, sessionId, now()),
      ),
    );
  }

  async routeFor(chatId: number, messageId: number): Promise<string | null> {
    const row = await this.d1
      .prepare("SELECT session_id FROM routes WHERE chat_id = ? AND message_id = ?")
      .bind(chatId, messageId)
      .first<{ session_id: string }>();
    return row?.session_id ?? null;
  }

  /** Создаёт запись о запросе разрешения; null, если такой уже есть. */
  async addConfirmation(sessionId: string, eventId: string, chatId: number): Promise<number | null> {
    const row = await this.d1
      .prepare("INSERT OR IGNORE INTO confirmations (session_id, event_id, chat_id) VALUES (?, ?, ?) RETURNING id")
      .bind(sessionId, eventId, chatId)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  async setConfirmationMessage(id: number, messageId: number) {
    await this.d1.prepare("UPDATE confirmations SET message_id = ? WHERE id = ?").bind(messageId, id).run();
  }

  /** Атомарно переводит запрос из pending в итоговый статус. */
  async resolveConfirmation(id: number, status: "allow" | "deny"): Promise<ConfirmationRow | null> {
    return this.d1
      .prepare("UPDATE confirmations SET status = ? WHERE id = ? AND status = 'pending' RETURNING *")
      .bind(status, id)
      .first<ConfirmationRow>();
  }

  async reopenConfirmation(id: number) {
    await this.d1.prepare("UPDATE confirmations SET status = 'pending' WHERE id = ?").bind(id).run();
  }

  async markFileSent(fileId: string, sessionId: string): Promise<boolean> {
    const res = await this.d1.prepare("INSERT OR IGNORE INTO sent_files (file_id, session_id) VALUES (?, ?)").bind(fileId, sessionId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async unmarkFileSent(fileId: string) {
    await this.d1.prepare("DELETE FROM sent_files WHERE file_id = ?").bind(fileId).run();
  }

  async recentSessionIds(sinceMs: number): Promise<string[]> {
    const res = await this.d1
      .prepare("SELECT session_id FROM sessions WHERE created_at > ? ORDER BY created_at DESC LIMIT 50")
      .bind(sinceMs)
      .all<{ session_id: string }>();
    return res.results.map((r) => r.session_id);
  }

  async prune() {
    const weekAgo = now() - 7 * 24 * 3600_000;
    const monthAgo = now() - 30 * 24 * 3600_000;
    await this.d1.batch([
      this.d1.prepare("DELETE FROM seen_webhooks WHERE at < ?").bind(weekAgo),
      this.d1.prepare("DELETE FROM routes WHERE at < ?").bind(monthAgo),
    ]);
  }
}
