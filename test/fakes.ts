// Подделки для локальной проверки: D1 поверх node:sqlite, Telegram через перехват
// fetch, и фальшивый клиент Anthropic с теми методами, что использует посредник.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { App, Env } from "../src/app";
import { Db } from "../src/db";
import { Telegram } from "../src/telegram";

// ---------------- D1 ----------------
class Stmt {
  private args: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = args.map((a) => (a === undefined ? null : a));
    return this;
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
}
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.resolve(import.meta.dirname, "../schema.sql"), "utf8"));
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

// ---------------- Telegram ----------------
export interface TgCall {
  method: string;
  body: Record<string, unknown>;
}
export function installFakeTelegram() {
  const calls: TgCall[] = [];
  let nextId = 1000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/file/")) return new Response("FILEBYTES");
    const m = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
    if (!m) return realFetch(input, init);
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : `<file ${(v as File).name}>`;
    } else if (typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({ method: m[1], body });
    const method = m[1];
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "test_bot" } });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: "documents/file_7.pdf", file_size: 10 } });
    if (method === "sendMessage" || method === "sendDocument") {
      // HTML с ошибкой разметки: проверяем откат на простой текст
      if (body.parse_mode === "HTML" && String(body.text).includes("&lt;broken&gt;")) {
        return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
      }
      return Response.json({ ok: true, result: { message_id: nextId++, chat: { id: Number(body.chat_id) }, date: 0, text: body.text } });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch), sent: () => calls.filter((c) => c.method === "sendMessage") };
}

// ---------------- Anthropic ----------------
type Ev = { id: string; type: string; processed_at: string; [k: string]: unknown };
interface FakeSession {
  id: string;
  agent: { id: string };
  metadata: Record<string, string>;
  status: string;
  archived_at: string | null;
  budget: unknown;
  usage: { list_cost: { amount: string; currency: string } };
  updated_at: string;
  deployment_id?: string | null;
  resources: unknown[];
  events: Ev[];
}

let clock = Date.parse("2026-11-01T08:00:00.000Z");
const tick = () => new Date((clock += 1000)).toISOString();

async function* iter<T>(items: T[]) {
  for (const i of items) yield i;
}

export class FakeAnthropic {
  sessions = new Map<string, FakeSession>();
  sent: { sessionId: string; events: Record<string, unknown>[] }[] = [];
  created: Record<string, unknown>[] = [];
  outputFiles: { id: string; filename: string; size_bytes: number; scope: string }[] = [];
  resourcesAdded: { sessionId: string; params: Record<string, unknown> }[] = [];
  runs: string[] = [];
  memoryStores: { id: string; name: string; memories: { path: string; content: string }[] }[] = [];
  sendFailures: Error[] = [];
  private n = 0;
  private realWebhooks = new Anthropic({ apiKey: "test" }).beta.webhooks;

  addSession(id: string, agentId: string, metadata: Record<string, string> = {}, extra: Partial<FakeSession> = {}) {
    const s: FakeSession = {
      id,
      agent: { id: agentId },
      metadata,
      status: "idle",
      archived_at: null,
      budget: null,
      usage: { list_cost: { amount: "37", currency: "USD" } },
      updated_at: new Date(clock).toISOString(),
      resources: [],
      events: [],
      ...extra,
    };
    this.sessions.set(id, s);
    return s;
  }

  push(sessionId: string, ev: Record<string, unknown>) {
    const s = this.sessions.get(sessionId)!;
    const e = { id: `sevt_${++this.n}`, processed_at: tick(), ...ev } as Ev;
    s.events.push(e);
    s.updated_at = new Date(clock).toISOString();
    return e;
  }

  beta = {
    sessions: {
      create: async (p: Record<string, unknown>) => {
        this.created.push(p);
        const id = `sesn_${++this.n}`;
        this.addSession(id, String(p.agent), (p.metadata as Record<string, string>) ?? {}, { budget: p.budget, resources: p.resources as unknown[] });
        return this.sessions.get(id)!;
      },
      retrieve: async (id: string) => {
        const s = this.sessions.get(id);
        if (!s) throw new Anthropic.NotFoundError(404, undefined, "not found", new Headers());
        return s;
      },
      list: (p: { agent_id?: string }) => iter([...this.sessions.values()].filter((s) => !p.agent_id || s.agent.id === p.agent_id).reverse()),
      events: {
        list: (id: string, p: { types?: string[]; "created_at[gte]"?: string }) =>
          iter(
            this.sessions
              .get(id)!
              .events.filter((e) => !p.types || p.types.includes(e.type))
              .filter((e) => !p["created_at[gte]"] || e.processed_at >= p["created_at[gte]"]),
          ),
        send: async (id: string, body: { events: Record<string, unknown>[] }) => {
          const failure = this.sendFailures.shift();
          if (failure) throw failure;
          this.sent.push({ sessionId: id, events: body.events });
          for (const e of body.events) if (e.type === "user.tool_confirmation") this.push(id, { ...e });
          return {};
        },
      },
      resources: {
        add: async (sessionId: string, params: Record<string, unknown>) => {
          this.resourcesAdded.push({ sessionId, params });
          return { id: "sesrsc_1", ...params };
        },
      },
    },
    files: {
      list: (p: { scope_id: string }) => iter(this.outputFiles.filter((f) => f.scope === p.scope_id)),
    },
    deployments: { run: async (id: string) => (this.runs.push(id), { id: "drun_1" }) },
    memoryStores: {
      create: async (p: { name: string }) => {
        const store = { id: `memstore_f${++this.n}`, name: p.name, memories: [] as { path: string; content: string }[] };
        this.memoryStores.push(store);
        return store;
      },
      memories: {
        create: async (storeId: string, p: { path: string; content: string }) => {
          this.memoryStores.find((m) => m.id === storeId)!.memories.push(p);
          return { id: `mem_${++this.n}`, ...p };
        },
      },
    },
    deploymentRuns: { retrieve: async () => ({ error: { type: "agent_archived_error", message: "агент в архиве" } }) },
    webhooks: this.realWebhooks,
  };

  files = {
    upload: async () => ({ id: `file_up_${++this.n}` }),
    download: async () => new Response("REPORTBYTES"),
  };
}

export const ENV: Omit<Env, "DB"> = {
  ANTHROPIC_API_KEY: "test",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TG_WEBHOOK_SECRET: "tgsecret",
  PAIR_CODE: "424242",
  AGENT_ID: "agent_chat",
  SCHEDULED_AGENT_ID: "agent_sched",
  FAMILY_AGENT_ID: "agent_family",
  ENVIRONMENT_ID: "env_1",
  MEMORY_STORE_ID: "memstore_1",
  DIGEST_DEPLOYMENT_ID: "depl_digest",
  MONITOR_DEPLOYMENT_ID: "depl_monitor",
  CHAT_BUDGET_CENTS: "300",
  WORKSPACE: "default",
  QUICK_POLL_SECONDS: "0",
};

export function makeTestApp(overrides: Partial<Env> = {}) {
  const d1 = fakeD1();
  const anthropic = new FakeAnthropic();
  const env = { ...ENV, ...overrides, DB: d1 as unknown as D1Database } as Env;
  const app: App = { env, db: new Db(env.DB), tg: new Telegram(env.TELEGRAM_BOT_TOKEN), anthropic: anthropic as unknown as Anthropic };
  return { app, anthropic, d1 };
}
