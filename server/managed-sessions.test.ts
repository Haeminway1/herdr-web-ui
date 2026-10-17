import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationUnavailable, conversationForPane, HistoryChanged, resolveTranscript } from "./conversation.ts";
import { labelManagedPanes, resolveManagedSession } from "./managed-sessions.ts";
import { createGjcStatus, gjcPanes } from "./gjc-status.ts";
import { omoPanes, omoSessionForPane } from "./omo.ts";

const nonce = "0123456789abcdef0123456789abcdef";
const sessionId = "01a147f3-ec90-756f-948e-9fcb84998ec3";
let root: string, namespace: string, sessionFile: string, recordFile: string;
let pane: HerdrPane;
let record: Record<string, unknown>;
let oldNamespace: string | undefined;
const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const save = () => writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
const resolve = () => resolveManagedSession(pane, namespace)!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-managed-identity-"));
  namespace = join(root, "managed-sessions");
  const directory = join(namespace, `${nonce}.sessions`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  recordFile = join(namespace, `${nonce}.json`);
  sessionFile = join(directory, "exact.jsonl");
  writeFileSync(sessionFile, [JSON.stringify({ type: "session", id: sessionId, cwd: root }), message("user", "fixture question"), message("assistant", "exact managed answer")].join("\n") + "\n", { mode: 0o600 });
  const info = statSync(sessionFile);
  pane = { pane_id: "wFixture:p1", workspace_id: "wFixture", tab_id: "wFixture:t1", terminal_id: "term_fixture", cwd: root, agent: "codex", agent_status: "unknown", revision: 1, focused: false, tokens: { hm_managed_session: nonce, hm_managed_generation: "1", hm_execution: "gjc fixture" } };
  record = { schema: 2, nonce, harness: "gjc", launcher_harness: "gjc", cwd: root, pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, generation: 1, desired_state: "running", state: "ready", session_id: sessionId, session_file: sessionFile, session_dir: directory, file_identity: { dev: info.dev, ino: info.ino }, env: {} };
  save();
  oldNamespace = process.env.HERDR_MANAGED_NAMESPACE;
  process.env.HERDR_MANAGED_NAMESPACE = namespace;
});
afterEach(() => {
  if (oldNamespace === undefined) delete process.env.HERDR_MANAGED_NAMESPACE;
  else process.env.HERDR_MANAGED_NAMESPACE = oldNamespace;
  rmSync(root, { recursive: true, force: true });
});

it("routes a managed GJC ahead of a misleading Codex child and unrelated newer files", async () => {
  const other = join(String(record.session_dir), "newest.jsonl");
  writeFileSync(other, JSON.stringify({ type: "session", id: "wrong-session", cwd: root }) + "\n");
  utimesSync(other, new Date(), new Date(Date.now() + 60_000));
  expect(resolve()).toMatchObject({ identity: { state: "ready", harness: "gjc", generation: 1, session_id: sessionId }, sessionFile });
  expect(await resolveTranscript(pane, root)).toMatchObject({ source: "gjc-transcript", path: sessionFile });
  const answer = await conversationForPane(pane);
  expect(answer.source).toBe("gjc-transcript");
  expect(answer.managed_session?.session_id).toBe(sessionId);
  expect(answer.turns.flatMap(t => t.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(answer.history_id).toStartWith(`managed-${nonce}-1:`);
});

it("projects both panes and agents without converting identity ready into engine idle", () => {
  const snapshot = { panes: [pane], agents: [{ ...pane, name: "provider-child" }], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const result = labelManagedPanes(snapshot, namespace);
  expect(result.panes[0]).toMatchObject({ agent: "gjc", agent_status: "unknown", managed_session: { state: "ready" } });
  expect(result.agents[0]?.agent).toBe("gjc");
  expect(pane.agent).toBe("codex");
  expect(result.panes[0]?.agent_session?.value).toBe(sessionId);
  expect(JSON.stringify(result.panes[0]?.managed_session)).not.toContain("session_file");
});

it("leaves unmanaged snapshots untouched without reading unrelated agent projections", () => {
  const direct = { panes: [{ ...pane, tokens: {} }] } as SessionSnapshot;
  expect(labelManagedPanes(direct, namespace)).toBe(direct);
});

it("keeps production GJC status discovery on the managed file and out of OMO heuristics", async () => {
  const managedPane = { ...pane, agent: "gjc" };
  const unexpected = async (): Promise<never> => { throw new Error("managed identity must precede process discovery"); };
  const found = await gjcPanes([managedPane], { processInfo: unexpected, transcript: unexpected, underShell: unexpected });
  expect(found.get(pane.pane_id)?.path).toBe(sessionFile);
  expect((await omoPanes([managedPane])).size).toBe(0);
  record.state = "identity_pending"; save();
  expect((await gjcPanes([managedPane], { processInfo: unexpected, transcript: unexpected })).size).toBe(0);
  expect(await omoSessionForPane(pane.pane_id, root, [managedPane])).toEqual({ path: null, pending: null });
});

it("uses the exact private file for production managed OMO status discovery", async () => {
  record.harness = "omo"; record.launcher_harness = "omo"; save();
  expect((await omoPanes([pane])).get(pane.pane_id)?.path).toBe(sessionFile);
  expect(await omoSessionForPane(pane.pane_id, root, [pane])).toEqual({ path: sessionFile, pending: null });
});

it("invalidates native status discovery immediately when managed state or generation changes", async () => {
  const raw = { panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  let snapshot = labelManagedPanes(raw, namespace);
  let calls = 0;
  const tracker = createGjcStatus({
    snapshot: async () => snapshot,
    discover: async panes => { calls++; return gjcPanes(panes); },
    onChange: () => {}, now: () => 1000, refreshMs: 60_000,
  });
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(true);
  record.state = "identity_pending"; save();
  snapshot = labelManagedPanes(raw, namespace);
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(false);
  record.state = "ready"; record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save();
  snapshot = labelManagedPanes(raw, namespace);
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(true);
  expect(calls).toBe(3);
});

it.each(["intent", "registered", "starting", "identity_pending"])("reports %s as waiting without guessing or opening another transcript", async state => {
  record.state = state; record.session_id = ""; record.session_file = ""; save();
  expect(resolve()).toMatchObject({ identity: { state: "identity_pending", reason: "identity_pending", harness: "gjc" }, sessionFile: null });
  try { await conversationForPane(pane); throw new Error("should not resolve"); }
  catch (error) {
    expect(error).toBeInstanceOf(ConversationUnavailable);
    expect((error as ConversationUnavailable).managedSession?.state).toBe("identity_pending");
  }
});

it("reports only fixed blocked codes, never arbitrary process output from a record", async () => {
  record.state = "blocked"; record.error = "blocked_runtime_changed"; save();
  expect(resolve().identity.reason).toBe("blocked_runtime_changed");
  record.error = "private output\nnot a reason code"; save();
  expect(resolve().identity.reason).toBe("blocked_record_state");
  await expect(conversationForPane(pane)).rejects.toThrow("blocked_record_state");
});

it("refuses obsolete schema without treating a bound GJC as Codex or a direct session", async () => {
  record.schema = 1; delete record.file_identity; save();
  expect(resolve().identity).toMatchObject({ harness: "gjc", state: "blocked", reason: "blocked_record_schema", session_id: null });
  await expect(resolveTranscript(pane, root)).rejects.toThrow("blocked_record_schema");
});

it.each([
  ["generation", 2, "blocked_managed_generation"],
  ["nonce", "f".repeat(32), "blocked_record_identity"],
  ["terminal_id", "term_other", "blocked_pane_identity"],
  ["pane_id", "wOther:p1", "blocked_pane_identity"],
  ["workspace_id", "wOther", "blocked_pane_identity"],
  ["cwd", "/", "blocked_pane_identity"],
  ["launcher_harness", "codex", "blocked_record_harness"],
  ["desired_state", "stopped", "blocked_session_stopped"],
  ["state", "interrupted", "blocked_record_state"],
] as const)("rejects changed %s before transcript access", (key, value, reason) => {
  record[key] = value; save();
  expect(resolve().identity).toMatchObject({ state: "blocked", reason });
  expect(resolve().sessionFile).toBeNull();
});

it("refuses malformed or partial managed tokens but leaves unmanaged panes alone", () => {
  delete pane.tokens;
  expect(resolveManagedSession(pane, namespace)).toBeNull();
  for (const value of ["../escape", 42, "x".repeat(32)]) {
    pane.tokens = { hm_managed_session: value, hm_managed_generation: "1" };
    expect(resolve().identity.reason).toBe("blocked_managed_token");
  }
  pane.tokens = { hm_managed_generation: "1" };
  expect(resolve().identity.state).toBe("blocked");
  for (const value of ["0", "1e0", 1, "9007199254740992"]) {
    pane.tokens = { hm_managed_session: nonce, hm_managed_generation: value };
    expect(resolve().identity.reason).toBe("blocked_managed_generation");
  }
});

it("refuses missing, oversized, symlinked and publicly writable records", () => {
  const original = readFileSync(recordFile, "utf8");
  rmSync(recordFile);
  expect(resolve().identity.state).toBe("blocked");
  writeFileSync(recordFile, " ".repeat(65537));
  expect(resolve().identity.reason).toBe("blocked_record_owner");
  writeFileSync(recordFile, original); chmodSync(recordFile, 0o666);
  expect(resolve().identity.reason).toBe("blocked_record_owner");
  rmSync(recordFile);
  const outside = join(root, "record.json"); writeFileSync(outside, original); symlinkSync(outside, recordFile);
  expect(resolve().identity.state).toBe("blocked");
});

it("requires the exact ID, canonical project and pinned file identity", () => {
  for (const meta of [{ id: "another-id", cwd: root }, { id: sessionId, cwd: "/" }]) {
    writeFileSync(sessionFile, JSON.stringify({ type: "session", ...meta }) + "\n");
    expect(resolve().identity.reason).toBe("blocked_session_header");
  }
  record.file_identity = { dev: -1, ino: -1 }; save();
  expect(resolve().identity.reason).toBe("blocked_session_replaced");
});

it("rejects out-of-store and subagent substitutions even with a matching filename", () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n");
  record.session_file = outside; save();
  expect(resolve().identity.reason).toBe("blocked_session_root");
  record.session_file = sessionFile; save();
  rmSync(sessionFile); symlinkSync(outside, sessionFile);
  expect(resolve().identity.reason).toBe("blocked_session_root");
});

it("rejects a replaced generation's cursors even when it keeps the same exact file", async () => {
  const header = JSON.stringify({ type: "session", id: sessionId, cwd: root });
  writeFileSync(sessionFile, [header, ...Array.from({ length: 500 }, (_, i) => [message("user", `question ${i}`), message("assistant", `answer ${i}`)]).flat()].join("\n") + "\n");
  const first = await conversationForPane(pane);
  expect(first.cursor).toBeString();
  record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save();
  await expect(conversationForPane(pane, undefined, { before: first.cursor! })).rejects.toBeInstanceOf(HistoryChanged);
  const second = await conversationForPane(pane);
  expect(second.history_id).not.toBe(first.history_id);
  expect(second.version).not.toBe(first.version);
});

describe.each(["omo", "codex", "claude"] as const)("%s exact managed transcript", harness => {
  it("validates that harness's native header without any latest-session lookup", async () => {
    record.harness = harness; record.launcher_harness = harness;
    if (harness !== "omo") {
      const base = join(root, harness);
      mkdirSync(join(base, harness === "codex" ? "sessions" : "projects"), { recursive: true, mode: 0o700 });
      sessionFile = join(base, harness === "codex" ? "sessions" : "projects", "exact.jsonl");
      record.env = { [harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: base };
    }
    const meta = harness === "codex" ? { type: "session_meta", payload: { id: sessionId, cwd: root } }
      : harness === "claude" ? { sessionId, cwd: root, type: "user" } : { type: "session", id: sessionId, cwd: root };
    writeFileSync(sessionFile, JSON.stringify(meta) + "\n", { mode: 0o600 });
    const info = statSync(sessionFile);
    record.session_file = sessionFile; record.file_identity = { dev: info.dev, ino: info.ino }; save();
    expect(resolve().identity.state).toBe("ready");
    expect(await resolveTranscript(pane, root)).toMatchObject({ source: `${harness}-transcript`, path: sessionFile });
  });
});
