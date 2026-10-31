-- База посредника (Cloudflare D1). Здесь только служебные связи, никаких секретов
-- и никакой переписки: сама переписка хранится в сессиях Anthropic.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Текущий разговор в каждом чате Telegram
CREATE TABLE IF NOT EXISTS chats (
  chat_id                INTEGER PRIMARY KEY,
  session_id             TEXT,
  placeholder_message_id INTEGER,
  last_activity          INTEGER NOT NULL
);

-- Все сессии агента, которые знает посредник, и до какого события он их уже переслал
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  chat_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                -- chat | scheduled
  cursor_ts   TEXT,                         -- processed_at последнего обработанного события
  cursor_ids  TEXT NOT NULL DEFAULT '[]',   -- id событий с этим processed_at
  lock_until  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Защита от повторной доставки вебхуков Anthropic
CREATE TABLE IF NOT EXISTS seen_webhooks (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

-- Ответ (reply) на сообщение дайджеста/мониторинга продолжает ту же сессию
CREATE TABLE IF NOT EXISTS routes (
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

-- Запросы разрешения на действия агента (кнопки «Разрешить / Запретить»)
CREATE TABLE IF NOT EXISTS confirmations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_id   TEXT NOT NULL UNIQUE,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER,
  status     TEXT NOT NULL DEFAULT 'pending'
);

-- Файлы из /mnt/session/outputs, которые уже отправлены в Telegram
CREATE TABLE IF NOT EXISTS sent_files (
  file_id    TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

-- Кто может писать боту. owner — владелец; self — другие аккаунты владельца
-- (общая память и юридический профиль); family — член семьи (свой агент и своя память).
CREATE TABLE IF NOT EXISTS users (
  tg_id           INTEGER PRIMARY KEY,
  role            TEXT NOT NULL,
  name            TEXT,
  memory_store_id TEXT,
  added_at        INTEGER NOT NULL
);

-- Одноразовые коды приглашений (/invite)
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by    INTEGER
);
