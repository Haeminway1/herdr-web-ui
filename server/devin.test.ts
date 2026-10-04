import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevinHistoryChanged, devinConversation, listDevinSessions } from "./devin.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "devin-test-"));
  dirs.push(dir);
  const dbPath = join(dir, "sessions.db");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT, working_directory TEXT, main_chain_id INTEGER, hidden INTEGER, model TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER); CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT)");
  const cwd = "/synthetic/work";
  db.query("INSERT INTO sessions VALUES (?, ?, ?, 0, NULL)").run("one", cwd, null);
  const node = (id: number, parent: number | null, message: unknown, session = "one") => {
    db.query("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)").run(session, id, parent, typeof message === "string" ? message : JSON.stringify(message), 1_700_000_000 + id);
    db.query("UPDATE sessions SET main_chain_id = ? WHERE id = ?").run(id, session);
  };
  return { db, dbPath, cwd, node, page: (options: Parameters<typeof devinConversation>[2] = {}) => devinConversation("one", cwd, options, dbPath) };
}

test("exact identity, visible candidates and empty chain", () => {
  const f = fixture();
  f.db.query("INSERT INTO sessions VALUES ('two', ?, NULL, 0, NULL)").run(f.cwd);
  f.db.query("INSERT INTO sessions VALUES ('hidden', ?, NULL, 1, NULL)").run(f.cwd);
  expect(listDevinSessions(f.cwd, f.dbPath)).toEqual(["one", "two"]);
  expect(f.page().turns).toEqual([]);
  expect(f.page().cursor).toBeNull();
  expect(() => devinConversation("two", "/other", {}, f.dbPath)).toThrow();
  f.db.close();
});

test("reads WAL, main ancestry, tool results and updates without abandoned branch", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic question" });
  f.node(2, 1, { role: "assistant", content: "synthetic answer", thinking: "synthetic reasoning", metadata: { generation_model: "synthetic-model" }, tool_calls: [{ id: "call-1", name: "synthetic_tool", arguments: { n: 1 }, kind: "function", index: 0 }] });
  f.node(3, 2, { role: "tool", tool_call_id: "call-1", content: "synthetic result", is_error: true });
  f.node(4, 1, { role: "assistant", content: "abandoned" });
  f.db.query("UPDATE sessions SET main_chain_id = 3 WHERE id = 'one'").run();
  const state = f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call-1', '{}', ?)");
  state.run(JSON.stringify({ toolCallId: "call-1", status: "error", content: "synthetic updated result" }));
  const first = f.page();
  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[1]!.parts).toEqual([
    { kind: "thinking", text: "synthetic reasoning" },
    { kind: "text", text: "synthetic answer" },
    { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{\"n\":1}", output: "synthetic result", error: true },
  ]);
  expect(first.metadata.model).toBe("synthetic-model");
  expect(first.turns[0]!.ts).toBe("2023-11-14T22:13:21.000Z");
  state.run(JSON.stringify({ toolCallId: "call-1", status: "failed", content: "changed" }));
  expect(f.page().version).not.toBe(first.version);
  f.db.close();
});

test("paginates turns with stable cursors and rejects foreign and displaced cursors", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "one" });
  f.node(2, 1, { role: "assistant", content: "two" });
  f.node(3, 2, { role: "user", content: "three" });
  const latest = f.page({ limit: 2 });
  expect(latest.turns.length).toBe(2);
  expect(latest.cursor).not.toBeNull();
  const older = f.page({ before: latest.cursor!, limit: 2 });
  expect(older.turns[0]!.parts).toEqual([{ kind: "text", text: "one" }]);
  expect(older.cursor).toBeNull();
  expect(f.page({ from: latest.cursor! }).turns.length).toBe(2);
  f.node(4, 3, { role: "assistant", content: "four" });
  expect(f.page().history_id).toBe(latest.history_id);
  const moved = f.page({ from: latest.cursor!, limit: 1 });
  expect(moved.cursor).toBe(JSON.stringify(["one", 0, 4]));
  expect(f.page({ before: moved.cursor!, since: latest.cursor!, limit: 1 }).turns[0]!.parts).toEqual([{ kind: "text", text: "three" }]);
  expect(() => f.page({ before: JSON.stringify(["foreign", 0, 2]) })).toThrow(DevinHistoryChanged);
  f.db.query("UPDATE sessions SET main_chain_id = 1 WHERE id = 'one'").run();
  expect(f.page().history_id).not.toBe(latest.history_id);
  expect(() => f.page({ before: latest.cursor! })).toThrow(DevinHistoryChanged);
  f.db.close();
});

test("skips malformed, unknown and incomplete nodes", () => {
  const f = fixture();
  f.node(1, null, "{malformed");
  f.node(2, 1, { role: "unknown", content: "ignored" });
  f.node(3, 2, { role: "assistant", content: "valid" });
  expect(f.page().turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "valid" }]]);
  f.db.query("UPDATE sessions SET main_chain_id = 999 WHERE id = 'one'").run();
  expect(f.page().turns).toEqual([]);
  f.db.close();
});

test("system nodes before the first user do not create an empty earlier page", () => {
  const f = fixture();
  f.node(1, null, { role: "system", content: "synthetic setup" });
  f.node(2, 1, { role: "user", content: "synthetic prompt" });
  expect(f.page().cursor).toBeNull();
  f.db.close();
});
