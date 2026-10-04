import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationMetadata, ConversationPart, ConversationTurn } from "../shared/protocol.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parse = (value: string | null): Record<string, unknown> => {
  try { return record(JSON.parse(value ?? "")); } catch { return {}; }
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const toolContent = (value: unknown): string => Array.isArray(value)
  ? value.map((block) => text(record(record(block).content).text)).filter(Boolean).join("\n") : text(value);
const stamp = (value: number): string | null => Number.isFinite(value) && value > 0 ? new Date(value < 1e11 ? value * 1000 : value).toISOString() : null;
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

/** Returns only visible candidates; callers must resolve ambiguous cwd matches themselves. */
export function listDevinSessions(cwd: string, dbPath = defaultDevinDbPath()): string[] {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    return db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE working_directory = ? AND hidden = 0 ORDER BY id").all(cwd).map((row) => row.id);
  } finally { db.close(); }
}

export function defaultDevinDbPath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "cli", "sessions.db");
}

type Node = { node_id: number; parent_node_id: number | null; chat_message: string | null; created_at: number };
type ToolState = { tool_call_id: string; tool_call_json: string | null; tool_call_update_json: string | null };

/** Reads one explicitly identified native session without mutating its WAL database. */
export function devinConversation(sessionId: string, cwd: string, options: DevinPageOptions = {}, dbPath = defaultDevinDbPath()): DevinPage {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    // The writer can advance the head while we read; one snapshot keeps the chain
    // and its tool states from different commits from being joined together.
    db.exec("BEGIN");
    const session = db.query<{ main_chain_id: number | null; model: string | null }, [string, string]>(
      "SELECT main_chain_id, model FROM sessions WHERE id = ? AND working_directory = ? AND hidden = 0",
    ).get(sessionId, cwd);
    if (!session) throw new Error("Devin session does not match the requested directory");
    const nodes = db.query<Node, [string]>("SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes WHERE session_id = ?").all(sessionId);
    const byId = new Map(nodes.map((node) => [node.node_id, node]));
    const chain: Node[] = [];
    const visited = new Set<number>();
    let current = session.main_chain_id;
    while (current !== null && !visited.has(current)) {
      const node = byId.get(current);
      if (!node) break; // Ignore an incomplete or concurrently inserted chain head.
      chain.push(node);
      visited.add(current);
      current = node.parent_node_id;
    }
    const incomplete = current !== null;
    if (incomplete) chain.length = 0;
    chain.reverse();
    const states = db.query<ToolState, [string]>("SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?").all(sessionId);
    const updates = new Map(states.map((state) => [state.tool_call_id, state]));
    const key = JSON.stringify([dbPath, sessionId, cwd]);
    const ids = chain.map((node) => node.node_id);
    const previous = histories.get(key);
    const replacement = !incomplete && previous && (ids.length < previous.nodes.length || previous.nodes.some((id, index) => ids[index] !== id));
    const revision = (previous?.revision ?? 0) + (replacement ? 1 : 0);
    if (!incomplete) {
      histories.set(key, { nodes: ids, revision });
      if (histories.size > 64) histories.delete(histories.keys().next().value!);
    }
    const history_id = createHash("sha256").update(key).update(String(revision)).digest("hex");
    const versionHash = createHash("sha256").update(history_id).update(String(session.main_chain_id));
    for (const node of chain) versionHash.update(JSON.stringify(node));
    for (const state of states.sort((a, b) => a.tool_call_id.localeCompare(b.tool_call_id))) versionHash.update(JSON.stringify(state));
    const version = versionHash.digest("hex");
    const before = nodeCursor(options.before, sessionId, revision);
    const since = nodeCursor(options.since, sessionId, revision);
    const from = nodeCursor(options.from, sessionId, revision);
    for (const boundary of [before, since, from]) if (boundary !== null && !visited.has(boundary)) throw new DevinHistoryChanged();
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100) || 100));
    const positions = new Map(chain.map((node, index) => [node.node_id, index]));
    const turns: { node: number; turn: ConversationTurn }[] = [];
    const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
    let metadata: ConversationMetadata = { model: session.model, reasoning_effort: null };
    for (const node of chain) {
      const message = parse(node.chat_message);
      const role = message.role;
      if (role === "system") continue;
      const meta = record(message.metadata);
      if (typeof meta.generation_model === "string") metadata.model = meta.generation_model;
      if (typeof meta.reasoning_effort === "string") metadata.reasoning_effort = meta.reasoning_effort;
      const ts = stamp(node.created_at);
      if (role === "tool") {
        const part = pending.get(text(message.tool_call_id));
        if (part) {
          if (typeof message.content === "string" && message.content) part.output = message.content;
          if (message.is_error === true || message.error === true) part.error = true;
        }
        continue;
      }
      if (role !== "user" && role !== "assistant") continue;
      const parts: ConversationPart[] = [];
      if (role === "assistant" && typeof message.thinking === "string" && message.thinking) parts.push({ kind: "thinking", text: message.thinking });
      if (typeof message.content === "string" && message.content) parts.push({ kind: "text", text: message.content });
      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const rawCall of message.tool_calls) {
          const call = record(rawCall);
          if (!text(call.name)) continue;
          const id = text(call.id);
          const state = updates.get(id);
          const update = parse(state?.tool_call_update_json ?? null);
          const saved = parse(state?.tool_call_json ?? null);
          const args = call.arguments ?? saved.rawInput;
          const input = typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args);
          const part: Extract<ConversationPart, { kind: "tool" }> = { kind: "tool", name: text(call.name), summary: text(call.name), input, output: toolContent(update.content), ...(update.status === "error" || update.status === "failed" ? { error: true } : {}) };
          parts.push(part);
          if (id) pending.set(id, part);
        }
      }
      if (parts.length) {
        const last = turns.at(-1);
        if (role === "assistant" && last?.turn.role === "assistant") {
          last.turn.parts.push(...parts);
          last.turn.end_ts = ts ?? undefined;
        } else turns.push({ node: node.node_id, turn: { role, ts, parts } });
      }
    }
    const page = turns.filter(({ node }) => (before === null || positions.get(node)! < positions.get(before)!)
      && (since === null || positions.get(node)! >= positions.get(since)!)
      && (from === null || positions.get(node)! >= positions.get(from)!)).slice(-limit);
    const first = page[0]?.node;
    const firstTurn = turns[0]?.node;
    const pageCursor = first === undefined || (from === null && first === firstTurn) ? null
      : from !== null && first === from ? options.from! : cursor(sessionId, revision, first);
    return { source: "devin-transcript", turns: page.map(({ turn }) => turn), metadata, cursor: pageCursor, history_id, version };
  } finally { db.close(); }
}
