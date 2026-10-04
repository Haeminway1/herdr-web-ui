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

test("exact visible identity, ambiguous sessions, unsafe identifiers and empty ancestry", () => {
  const f = fixture();
  f.db.query("INSERT INTO sessions VALUES ('two', ?, NULL, 0, NULL)").run(f.cwd);
  f.db.query("INSERT INTO sessions VALUES ('hidden', ?, NULL, 1, NULL)").run(f.cwd);
  expect(listDevinSessions(f.cwd, f.dbPath)).toEqual(["one", "two"]);
  expect(listDevinSessions("/synthetic/other", f.dbPath)).toEqual([]);
  expect(f.page().turns).toEqual([]);
  expect(f.page().cursor).toBeNull();
  expect(() => devinConversation("one' OR 1=1 --", f.cwd, {}, f.dbPath)).toThrow();
  expect(() => devinConversation("hidden", f.cwd, {}, f.dbPath)).toThrow();
  expect(() => devinConversation("two", "/other", {}, f.dbPath)).toThrow();
  f.db.close();
});

test("reads WAL tool states and results while excluding abandoned branches", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic question" });
  f.node(2, 1, { role: "assistant", content: "synthetic answer", thinking: "synthetic reasoning", metadata: { generation_model: "synthetic-model" }, tool_calls: [{ id: "call-1", name: "synthetic_tool", arguments: { n: 1 } }] });
  f.node(3, 2, { role: "tool", tool_call_id: "call-1", content: "synthetic result", is_error: true });
  f.node(4, 1, { role: "assistant", content: "abandoned" });
  f.db.query("UPDATE sessions SET main_chain_id = 3 WHERE id = 'one'").run();
  f.db.query("INSERT INTO tool_call_state VALUES ('one', 'call-1', '{}', ?)").run(JSON.stringify({ status: "error", content: "synthetic updated result" }));
  const first = f.page();
  expect(first.source).toBe("devin-transcript");
  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[1]!.parts).toEqual([
    { kind: "thinking", text: "synthetic reasoning" },
    { kind: "text", text: "synthetic answer" },
    { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{\"n\":1}", output: "synthetic result", error: true },
  ]);
  expect(first.metadata.model).toBe("synthetic-model");
  expect(first.turns[0]!.ts).toBe("2023-11-14T22:13:21.000Z");
  f.db.query("UPDATE tool_call_state SET tool_call_update_json = ? WHERE tool_call_id = 'call-1'").run(JSON.stringify({ status: "failed", content: "changed" }));
  expect(f.page().version).not.toBe(first.version);
  f.db.close();
});

test("pagination, grouping, append and branch replacement", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "one" });
  f.node(2, 1, { role: "assistant", content: "two" });
  f.node(3, 2, { role: "assistant", content: "continuation" });
  f.node(4, 3, { role: "user", content: "three" });
  const latest = f.page({ limit: 2 });
  expect(latest.turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  expect(latest.turns[0]!.parts).toHaveLength(2);
  expect(f.page({ before: latest.cursor!, limit: 2 }).turns[0]!.parts).toEqual([{ kind: "text", text: "one" }]);
  expect(f.page({ from: latest.cursor! }).turns.length).toBe(2);
  f.node(5, 4, { role: "assistant", content: "four" });
  expect(f.page().history_id).toBe(latest.history_id);
  expect(f.page({ from: latest.cursor!, limit: 1 }).cursor).toBe(JSON.stringify(["one", 0, 5]));
  expect(() => f.page({ before: JSON.stringify(["foreign", 0, 2]) })).toThrow(DevinHistoryChanged);
  f.db.query("UPDATE sessions SET main_chain_id = 1 WHERE id = 'one'").run();
  expect(f.page().history_id).not.toBe(latest.history_id);
  expect(() => f.page({ before: latest.cursor! })).toThrow(DevinHistoryChanged);
  f.db.close();
});

test("malformed content and prelude do not create empty pages", () => {
  const f = fixture();
  f.node(1, null, { role: "system", content: "setup" });
  f.node(2, 1, "{malformed");
  f.node(3, 2, { role: "unknown", content: "ignored" });
  f.node(4, 3, { role: "assistant", content: "valid" });
  expect(f.page().turns.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "valid" }]]);
  expect(f.page().cursor).toBeNull();
  f.db.query("UPDATE sessions SET main_chain_id = 999 WHERE id = 'one'").run();
  expect(() => f.page()).toThrow(/missing/);
  f.db.close();
});

test("invalid native timestamps do not abort the conversation", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: "synthetic" });
  f.db.query("UPDATE message_nodes SET created_at = ? WHERE node_id = 1").run(1e20);
  expect(f.page().turns[0]?.ts).toBeNull();
  f.db.close();
});

test("long ancestry excludes unrelated branches and bounds excessive chains", () => {
  const f = fixture();
  f.db.exec("CREATE INDEX node_identity ON message_nodes(session_id, node_id)");
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, ?, 1700000000)");
  f.db.exec("BEGIN");
  for (let i = 1; i <= 1200; i++) insert.run(i, i === 1 ? null : i - 1, JSON.stringify({ role: "user", content: `active ${i}` }));
  for (let i = 1201; i <= 2400; i++) insert.run(i, i === 1201 ? 1 : i - 1, JSON.stringify({ role: "assistant", content: "unrelated" }));
  f.db.query("UPDATE sessions SET main_chain_id = 1200 WHERE id = 'one'").run();
  f.db.exec("COMMIT");
  const active = f.page({ limit: 2 });
  expect(active.turns.map((turn) => turn.parts[0])).toEqual([{ kind: "text", text: "active 1199" }, { kind: "text", text: "active 1200" }]);
  insert.run(2401, 2400, JSON.stringify({ role: "user", content: "another abandoned node" }));
  expect(f.page({ limit: 2 }).version).toBe(active.version);
  f.db.query("UPDATE sessions SET main_chain_id = 2400 WHERE id = 'one'").run();
  expect(f.page().history_id).not.toBe(active.history_id);
  f.db.query("UPDATE sessions SET main_chain_id = 5001 WHERE id = 'one'").run();
  expect(() => f.page()).toThrow(/missing/);
  f.db.close();
});

test("groups assistant continuations across tool nodes and ignores unknown content", () => {
  const f = fixture();
  f.node(1, null, { role: "user", content: { unsupported: true } });
  f.node(2, 1, { role: "assistant", tool_calls: [{ id: "call", name: "check", arguments: {} }] });
  f.node(3, 2, { role: "tool", tool_call_id: "call", content: "synthetic output" });
  f.node(4, 3, { role: "assistant", content: "synthetic answer" });
  expect(f.page().turns).toMatchObject([{ role: "assistant", parts: [
    { kind: "tool", output: "synthetic output" }, { kind: "text", text: "synthetic answer" },
  ] }]);
  f.db.close();
});

test("rejects a chain longer than the bounded reader window", () => {
  const f = fixture();
  f.db.exec("CREATE INDEX node_identity ON message_nodes(session_id, node_id); BEGIN");
  const insert = f.db.query("INSERT INTO message_nodes VALUES ('one', ?, ?, '{\"role\":\"user\",\"content\":\"synthetic\"}', 1700000000)");
  for (let i = 1; i <= 5001; i++) insert.run(i, i === 1 ? null : i - 1);
  f.db.query("UPDATE sessions SET main_chain_id = 5001 WHERE id = 'one'").run();
  f.db.exec("COMMIT");
  expect(() => f.page()).toThrow(/bounds/);
  f.db.close();
});
