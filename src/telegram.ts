import { toTelegramMessages } from "./format";

export class TelegramError extends Error {
  constructor(
    public method: string,
    public description: string,
    public status: number,
  ) {
    super(`Telegram ${method}: ${description}`);
  }
}

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
export interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  document?: TgDocument;
  photo?: TgPhotoSize[];
  voice?: { file_id: string };
  audio?: TgDocument;
  video?: TgDocument;
  reply_to_message?: TgMessage;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

type InlineKeyboard = { text: string; callback_data: string }[][];

export class Telegram {
  constructor(private token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({ ok: false, description: res.statusText }))) as {
      ok: boolean;
      result?: T;
      description?: string;
    };
    if (!json.ok) throw new TelegramError(method, json.description ?? "unknown error", res.status);
    return json.result as T;
  }

  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /** Отправляет Markdown-текст агента: режет на части, HTML с откатом на простой текст. */
  async sendMarkdown(chatId: number, markdown: string, extra: Record<string, unknown> = {}): Promise<number[]> {
    const ids: number[] = [];
    for (const part of toTelegramMessages(markdown)) {
      let msg: TgMessage;
      try {
        if (!part.html) throw new Error("too long for HTML");
        msg = await this.sendMessage(chatId, part.html, { parse_mode: "HTML", ...extra });
      } catch {
        msg = await this.sendMessage(chatId, part.plain, extra);
      }
      ids.push(msg.message_id);
    }
    return ids;
  }

  sendButtons(chatId: number, text: string, keyboard: InlineKeyboard) {
    return this.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
  }

  editText(chatId: number, messageId: number, text: string) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }

  typing(chatId: number) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  async sendDocument(chatId: number, data: ArrayBuffer, filename: string, caption?: string) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new File([data], filename));
    if (caption) form.append("caption", caption.slice(0, 1000));
    return this.call<TgMessage>("sendDocument", form);
  }

  async downloadFile(fileId: string): Promise<{ data: ArrayBuffer; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram не отдал путь к файлу (файл больше 20 МБ?)");
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Не удалось скачать файл из Telegram: ${res.status}`);
    return { data: await res.arrayBuffer(), path: file.file_path };
  }
}
