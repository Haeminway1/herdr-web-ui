import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";

const MAX_NODES = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const text = (value: unknown): string => typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parse = (value: string | null): Record<string, unknown> => {
  try { return record(JSON.parse(value ?? "")); } catch { return {}; }
};
const toolContent = (value: unknown): string => Array.isArray(value)
  ? value.map((block) => text(record(record(block).content).text)).filter(Boolean).join("\n").slice(0, MAX_TEXT) : text(value);
const stamp = (value: number): string | null => {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export class DevinHistoryChanged extends Error {
  constructor() { super("Devin history changed"); this.name = "DevinHistoryChanged"; }
}
const histories = new Map<string, { nodes: number[]; revision: number }>();
const cursor = (id: string, revision: number, node: number): string => JSON.stringify([id, revision, node]);
const nodeCursor = (value: string | undefined, id: string, revision: number): number | null => {
  if (!value) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new DevinHistoryChanged(); }
  if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== id || decoded[1] !== revision || !Number.isSafeInteger(decoded[2]) || decoded[2] < 0) throw new DevinHistoryChanged();
  return decoded[2] as number;
};

export interface DevinPageOptions { before?: string; since?: string; from?: string; limit?: number }
export interface DevinPage {
  source: "devin-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  cursor: string | null;
  history_id: string;
  version: string;
}

export function defaultDevinDbPath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "cli", "sessions.db");
}

/** Returns only exact-directory visible candidates; the caller resolves ambiguity. */
export function listDevinSessions(cwd: string, dbPath = defaultDevinDbPath()): string[] {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    return db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE working_directory = ? AND hidden = 0 ORDER BY id LIMIT 101").all(cwd).map((row) => row.id);
  } finally { db.close(); }
}

type Node = { node_id: number; parent_node_id: number | null; chat_message: string | null; created_at: number; depth: number; bytes: number };
type ToolState = { tool_call_id: string; tool_call_json: string | null; tool_call_update_json: string | null };

/** Reads a single exact, visible native session in a readonly WAL snapshot. */
export function devinConversation(sessionId: string, cwd: string, options: DevinPageOptions = {}, dbPath = defaultDevinDbPath()): DevinPage {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("BEGIN");
    const session = db.query<{ main_chain_id: number | null; model: string | null }, [string, string]>(
      "SELECT main_chain_id, model FROM sessions WHERE id = ? AND working_directory = ? AND hidden = 0",
    ).get(sessionId, cwd);
    if (!session) throw new Error("Devin session does not match the requested directory");
    // Follow only the selected head, not every branch in the session.
    const chain = session.main_chain_id === null ? [] : db.query<Node, [number, string, string]>(`
      WITH RECURSIVE ancestry(node_id, parent_node_id, chat_message, created_at, depth, bytes) AS (
        SELECT node_id, parent_node_id, substr(chat_message, 1, ${MAX_BYTES + 1}), created_at, 1, length(coalesce(chat_message, ''))
        FROM message_nodes WHERE node_id = ? AND session_id = ?
        UNION ALL
        SELECT n.node_id, n.parent_node_id, substr(n.chat_message, 1, ${MAX_BYTES + 1}), n.created_at, a.depth + 1,
          a.bytes + length(coalesce(n.chat_message, ''))
        FROM message_nodes n JOIN ancestry a ON n.node_id = a.parent_node_id AND n.session_id = ?
        WHERE a.depth < ${MAX_NODES} AND a.bytes < ${MAX_BYTES}
      ) SELECT * FROM ancestry
    `).all(session.main_chain_id, sessionId, sessionId).reverse();
    if (chain.length && (chain[0]!.parent_node_id !== null || chain.length >= MAX_NODES || chain.at(-1)!.bytes >= MAX_BYTES)) throw new Error("Devin history exceeds reader bounds or is incomplete");
    if (session.main_chain_id !== null && !chain.length) throw new Error("Devin history head is missing");
    const ids = chain.map((node) => node.node_id);
    if (new Set(ids).size !== ids.length) throw new Error("Devin history contains a cycle");
    const key = JSON.stringify([dbPath, sessionId, cwd]);
    const previous = histories.get(key);
    const replacement = previous && (ids.length < previous.nodes.length || previous.nodes.some((id, index) => ids[index] !== id));
    const revision = (previous?.revision ?? 0) + (replacement ? 1 : 0);
    histories.set(key, { nodes: ids, revision });
    if (histories.size > 64) histories.delete(histories.keys().next().value!);
    const history_id = createHash("sha256").update(key).update(String(revision)).digest("hex");
    const before = nodeCursor(options.before, sessionId, revision);
    const since = nodeCursor(options.since, sessionId, revision);
    const from = nodeCursor(options.from, sessionId, revision);
    const positions = new Map(ids.map((id, index) => [id, index]));
    for (const boundary of [before, since, from]) if (boundary !== null && !positions.has(boundary)) throw new DevinHistoryChanged();

    const calls = new Set<string>();
    for (const node of chain) {
      const message = parse(node.chat_message);
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) for (const raw of message.tool_calls) {
        const id = text(record(raw).id);
        if (id) calls.add(id);
      }
    }
    const states: ToolState[] = [];
    const callIds = [...calls];
    let stateBytes = 0;
    for (let i = 0; i < callIds.length; i += 250) {
      const batch = callIds.slice(i, i + 250);
      for (const state of db.query<ToolState, string[]>(`SELECT tool_call_id, substr(tool_call_json, 1, ${MAX_TEXT + 1}) AS tool_call_json, substr(tool_call_update_json, 1, ${MAX_TEXT + 1}) AS tool_call_update_json FROM tool_call_state WHERE session_id = ? AND tool_call_id IN (${batch.map(() => "?").join(",")})`).all(sessionId, ...batch)) {
        stateBytes += (state.tool_call_json?.length ?? 0) + (state.tool_call_update_json?.length ?? 0);
        if (stateBytes > MAX_BYTES) throw new Error("Devin tool states exceed reader bounds");
        states.push(state);
      }
    }
    const updates = new Map(states.map((state) => [state.tool_call_id, state]));
    const hash = createHash("sha256").update(history_id).update(String(session.main_chain_id));
    for (const node of chain) hash.update(JSON.stringify(node));
    for (const state of states.sort((a, b) => a.tool_call_id.localeCompare(b.tool_call_id))) hash.update(JSON.stringify(state));
    const version = hash.digest("hex");
    const turns: { node: number; turn: ConversationTurn }[] = [];
    const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
    const metadata: ConversationMetadata = { model: session.model, reasoning_effort: null };
    for (const node of chain) {
      const message = parse(node.chat_message);
      const role = message.role;
      if (role === "system") continue;
      const meta = record(message.metadata);
      if (typeof meta.generation_model === "string") metadata.model = text(meta.generation_model);
      if (typeof meta.reasoning_effort === "string") metadata.reasoning_effort = text(meta.reasoning_effort);
      const ts = stamp(node.created_at);
      if (role === "tool") {
        const part = pending.get(text(message.tool_call_id));
        if (part) {
          if (typeof message.content === "string" && message.content) part.output = text(message.content);
          if (message.is_error === true || message.error === true) part.error = true;
        }
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;
      const parts: ConversationPart[] = [];
      if (role === "assistant" && text(message.thinking)) parts.push({ kind: "thinking", text: text(message.thinking) });
      if (text(message.content)) parts.push({ kind: "text", text: text(message.content) });
      if (role === "assistant" && Array.isArray(message.tool_calls)) for (const rawCall of message.tool_calls) {
        const call = record(rawCall);
        if (!text(call.name)) continue;
        const id = text(call.id);
        const state = updates.get(id);
        const update = parse(state?.tool_call_update_json ?? null);
        const saved = parse(state?.tool_call_json ?? null);
        const args = call.arguments ?? saved.rawInput;
        const input = typeof args === "string" ? text(args) : args === undefined ? "" : JSON.stringify(args).slice(0, MAX_TEXT);
        const part: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: text(call.name), summary: text(call.name), input, output: toolContent(update.content), ...(update.status === "error" || update.status === "failed" ? { error: true } : {}) };
        parts.push(part);
        if (id) pending.set(id, part);
      }
      if (parts.length) {
        const last = turns.at(-1);
        if (role === "assistant" && last?.turn.role === "assistant") {
          last.turn.parts.push(...parts);
          last.turn.end_ts = ts ?? undefined;
        } else turns.push({ node: node.node_id, turn: { role, ts, parts } });
      }
    }
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100) || 100));
    const page = turns.filter(({ node }) => (before === null || positions.get(node)! < positions.get(before)!)
      && (since === null || positions.get(node)! >= positions.get(since)!)
      && (from === null || positions.get(node)! >= positions.get(from)!)).slice(-limit);
    const first = page[0]?.node;
    const pageCursor = first === undefined || (from === null && first === turns[0]?.node) ? null
      : from !== null && first === from ? options.from! : cursor(sessionId, revision, first);
    return { source: "devin-transcript", turns: page.map(({ turn }) => turn), metadata, cursor: pageCursor, history_id, version };
  } finally { db.close(); }
}
