import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationUnavailable, conversationForPane as readConversation, HistoryChanged, resolveTranscript as readTranscript } from "./conversation.ts";
import { labelManagedPanes as projectPanes, resolveManagedSession, type ManagedSessionDeps } from "./managed-sessions.ts";
import type { GjcSdkSessionIdentity } from "./gjc-sdk.ts";
import { createGjcStatus, gjcPanes as discoverGjc } from "./gjc-status.ts";
import { omoPanes, omoSessionForPane } from "./omo.ts";

const nonce = "0123456789abcdef0123456789abcdef";
const sessionId = "00000000-0000-4000-8000-000000000001";
let root: string, namespace: string, sessionFile: string, recordFile: string;
let pane: HerdrPane;
let record: Record<string, unknown>;
let oldNamespace: string | undefined;
let observed: { pid: number; starttime: string; boot: string; cwd: string } | null;
let live: GjcSdkSessionIdentity | null;
const deps: ManagedSessionDeps = {
  processIdentity: pid => observed?.pid === pid ? { ...observed } : null,
  gjcSession: async () => live,
};
const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const save = () => writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
const useOmo = () => { record.harness = "omo"; record.launcher_harness = "omo"; save(); };
const pinCurrentFile = () => { const info = statSync(sessionFile); record.file_identity = { dev: info.dev, ino: info.ino }; save(); };
const resolve = async () => (await resolveManagedSession(pane, namespace, deps))!;
const labelManagedPanes = (snapshot: SessionSnapshot) => projectPanes(snapshot, namespace, deps);
const resolveTranscript = (target: HerdrPane, cwd: string) => readTranscript(target, cwd, undefined, undefined, undefined, undefined, undefined, deps);
const conversationForPane = (target: HerdrPane, home?: string, page?: Parameters<typeof readConversation>[2]) => readConversation(target, home, page, deps);
const gjcPanes = (panes: HerdrPane[], options: Parameters<typeof discoverGjc>[1] = {}) => discoverGjc(panes, { ...options, managedSession: target => resolveManagedSession(target, namespace, deps) });

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
  observed = { pid: 42, starttime: "123", boot: "fixture-boot", cwd: root };
  live = { sessionId, pid: 42, hostIncarnation: "linux:123", endpointGeneration: 1 };
  record = { schema: 2, nonce, harness: "gjc", launcher_harness: "gjc", cwd: root, pane_id: pane.pane_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, generation: 1, desired_state: "running", state: "ready", session_id: sessionId, session_file: sessionFile, session_dir: directory, file_identity: { dev: info.dev, ino: info.ino }, child: { ...observed }, env: {} };
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
  expect(await resolve()).toMatchObject({ identity: { state: "ready", harness: "gjc", generation: 1, session_id: sessionId }, sessionFile });
  expect(await resolveTranscript(pane, root)).toMatchObject({ source: "gjc-transcript", path: sessionFile });
  const answer = await conversationForPane(pane);
  expect(answer.source).toBe("gjc-transcript");
  expect(answer.managed_session?.session_id).toBe(sessionId);
  expect(answer.turns.flatMap(t => t.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(answer.history_id).toStartWith(`managed-${nonce}-1:`);
});

it("projects both panes and agents without converting identity ready into engine idle", async () => {
  const snapshot = { panes: [pane], agents: [{ ...pane, name: "provider-child" }], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const result = await labelManagedPanes(snapshot);
  expect(result.panes[0]).toMatchObject({ agent: "gjc", agent_status: "unknown", managed_session: { state: "ready" } });
  expect(result.agents[0]?.agent).toBe("gjc");
  expect(pane.agent).toBe("codex");
  expect(result.panes[0]?.agent_session?.value).toBe(sessionId);
  expect(JSON.stringify(result.panes[0]?.managed_session)).not.toContain("session_file");
});

it("leaves unmanaged snapshots untouched without reading unrelated agent projections", async () => {
  const direct = { panes: [{ ...pane, tokens: {} }] } as SessionSnapshot;
  expect(await labelManagedPanes(direct)).toBe(direct);
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
  let snapshot = await labelManagedPanes(raw);
  let calls = 0;
  const tracker = createGjcStatus({ snapshot: async () => snapshot, discover: async panes => { calls++; return gjcPanes(panes); }, onChange: () => {}, now: () => 1000, refreshMs: 60_000 });
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(true);
  record.state = "identity_pending"; save(); snapshot = await labelManagedPanes(raw);
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(false);
  record.state = "ready"; record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save(); snapshot = await labelManagedPanes(raw);
  await tracker.refresh(snapshot.panes);
  expect(tracker.runs(pane.pane_id)).toBe(true);
  expect(calls).toBe(3);
});

it.each(["intent", "registered", "starting", "identity_pending"])("reports %s as waiting without guessing or opening another transcript", async state => {
  record.state = state; record.session_id = ""; record.session_file = ""; save();
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending", reason: "identity_pending", harness: "gjc" }, sessionFile: null });
  try { await conversationForPane(pane); throw new Error("should not resolve"); }
  catch (error) { expect(error).toBeInstanceOf(ConversationUnavailable); expect((error as ConversationUnavailable).managedSession?.state).toBe("identity_pending"); }
});

it("reports only fixed blocked codes, never arbitrary process output from a record", async () => {
  record.state = "blocked"; record.error = "blocked_runtime_changed"; save();
  expect((await resolve()).identity.reason).toBe("blocked_runtime_changed");
  record.error = "private output\nnot a reason code"; save();
  expect((await resolve()).identity.reason).toBe("blocked_record_state");
  await expect(conversationForPane(pane)).rejects.toThrow("blocked_record_state");
});

it("connects the existing managed record using live SDK identity, without upgrading recovery metadata", async () => {
  record.schema = 1; delete record.file_identity; save();
  const original = readFileSync(recordFile, "utf8");
  expect((await resolve()).identity).toMatchObject({ harness: "gjc", state: "ready", session_id: sessionId });
  expect(await resolveTranscript(pane, root)).toMatchObject({ path: sessionFile });
  expect((await conversationForPane(pane)).turns.flatMap(t => t.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(readFileSync(recordFile, "utf8")).toBe(original);
});

it.each(["sessionId", "pid", "hostIncarnation"] as const)("rejects a live SDK %s mismatch without reading another session", async field => {
  live = { ...live!, [field]: field === "pid" ? 43 : "another-identity" };
  expect((await resolve()).identity.reason).toBe("blocked_gjc_session_mismatch");
  await expect(conversationForPane(pane)).rejects.toThrow("blocked_gjc_session_mismatch");
});

it("waits when SDK authority is absent, even with a pinned inode", async () => {
  live = null;
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, sessionFile: null });
  await expect(conversationForPane(pane)).rejects.toThrow("identity_pending");
});

it.each(["starttime", "boot", "cwd"] as const)("rejects a changed process %s", async field => {
  observed = { ...observed!, [field]: "changed" };
  expect((await resolve()).identity.reason).toBe("blocked_runtime_identity");
});

it("rejects process reuse and record changes during the native SDK lookup", async () => {
  const result = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => { observed = null; return live; } });
  expect(result?.identity.reason).toBe("blocked_runtime_identity");
  observed = { ...(record.child as NonNullable<typeof observed>) };
  const changed = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => { record.generation = 2; save(); return live; } });
  expect(changed?.identity.state).toBe("identity_pending");
});

it("does not mistake record heartbeat updates for a session identity change", async () => {
  const result = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => { record.observed_at = Date.now(); save(); return live; } });
  expect(result?.identity.state).toBe("ready");
});

it("rejects a header rewritten in place during native identity lookup", async () => {
  const result = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => {
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "changed", cwd: root }) + "\n");
    return live;
  } });
  expect(result?.identity.reason).toBe("blocked_session_header");
});

it("rejects a symlink substitution during native identity lookup", async () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, readFileSync(sessionFile));
  const result = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => {
    rmSync(sessionFile); symlinkSync(outside, sessionFile); return live;
  } });
  expect(result?.identity.reason).toBe("blocked_session_replaced");
});

it("rejects a native session switch across a transcript read", async () => {
  let calls = 0;
  await expect(readConversation(pane, undefined, {}, { ...deps, gjcSession: async () => ++calls === 1 ? live : { ...live!, sessionId: "switched" } })).rejects.toThrow("blocked_managed_identity_changed");
});

it.each([
  ["generation", 2, "blocked_managed_generation"], ["nonce", "f".repeat(32), "blocked_record_identity"],
  ["terminal_id", "term_other", "blocked_pane_identity"], ["pane_id", "wOther:p1", "blocked_pane_identity"],
  ["workspace_id", "wOther", "blocked_pane_identity"], ["cwd", "/", "blocked_pane_identity"],
  ["launcher_harness", "codex", "blocked_record_harness"], ["desired_state", "stopped", "blocked_session_stopped"],
  ["state", "interrupted", "blocked_record_state"],
] as const)("rejects changed %s before transcript access", async (key, value, reason) => {
  record[key] = value; save();
  expect(await resolve()).toMatchObject({ identity: { state: "blocked", reason }, sessionFile: null });
});

it("refuses malformed or partial managed tokens but leaves unmanaged panes alone", async () => {
  delete pane.tokens;
  expect(await resolveManagedSession(pane, namespace, deps)).toBeNull();
  for (const value of ["../escape", 42, "x".repeat(32)]) { pane.tokens = { hm_managed_session: value, hm_managed_generation: "1" }; expect((await resolve()).identity.reason).toBe("blocked_managed_token"); }
  pane.tokens = { hm_managed_generation: "1" }; expect((await resolve()).identity.state).toBe("blocked");
  for (const value of ["0", "1e0", 1, "9007199254740992"]) { pane.tokens = { hm_managed_session: nonce, hm_managed_generation: value }; expect((await resolve()).identity.reason).toBe("blocked_managed_generation"); }
});

it("refuses missing, oversized, symlinked and publicly writable records", async () => {
  const original = readFileSync(recordFile, "utf8"); rmSync(recordFile);
  expect((await resolve()).identity.state).toBe("blocked");
  writeFileSync(recordFile, " ".repeat(65537)); expect((await resolve()).identity.reason).toBe("blocked_record_owner");
  writeFileSync(recordFile, original); chmodSync(recordFile, 0o666); expect((await resolve()).identity.reason).toBe("blocked_record_owner");
  rmSync(recordFile); const outside = join(root, "record.json"); writeFileSync(outside, original); symlinkSync(outside, recordFile);
  expect((await resolve()).identity.state).toBe("blocked");
});

it("requires the exact ID, canonical project and pinned file identity", async () => {
  for (const meta of [{ id: "another-id", cwd: root }, { id: sessionId, cwd: "/" }]) {
    writeFileSync(sessionFile, JSON.stringify({ type: "session", ...meta }) + "\n"); expect((await resolve()).identity.reason).toBe("blocked_session_header");
  }
  record.file_identity = { dev: -1, ino: -1 }; save(); expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
});

describe("pinned managed OMO transcripts", () => {
  it("serves a group-writable pinned OMO transcript from its private nonce store", async () => {
    useOmo(); chmodSync(sessionFile, 0o664);
    expect(await resolve()).toMatchObject({ identity: { state: "ready", harness: "omo", session_id: sessionId }, sessionFile });
    const answer = await conversationForPane(pane);
    expect(answer.source).toBe("omo-transcript");
    expect(answer.turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  });

  it("recovers from an OMO identity-pending record when its pin arrives", async () => {
    useOmo(); delete record.file_identity; save();
    expect(await resolve()).toMatchObject({ identity: { state: "identity_pending", reason: "identity_pending" }, sessionFile: null });
    await expect(conversationForPane(pane)).rejects.toThrow("identity_pending");
    pinCurrentFile();
    const answer = await conversationForPane(pane);
    expect(answer.source).toBe("omo-transcript");
    expect(answer.turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  });

  it("rejects malformed OMO pins instead of treating them as absent", async () => {
    useOmo();
    for (const pin of [null, { dev: statSync(sessionFile).dev }, { dev: "wrong", ino: statSync(sessionFile).ino }]) {
      record.file_identity = pin; save();
      expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
    }
  });

  it("recovers after an incorrect group-writable OMO pin is corrected", async () => {
    useOmo(); chmodSync(sessionFile, 0o664);
    const info = statSync(sessionFile);
    record.file_identity = { dev: info.dev, ino: info.ino + 1 }; save();
    expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
    await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_replaced");
    pinCurrentFile();
    expect((await conversationForPane(pane)).source).toBe("omo-transcript");
  });

  it("recovers after world-write is removed from a pinned OMO file", async () => {
    useOmo(); chmodSync(sessionFile, 0o666);
    expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
    await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_replaced");
    chmodSync(sessionFile, 0o664);
    expect((await conversationForPane(pane)).source).toBe("omo-transcript");
  });

  it.each([0o750, 0o755])("rejects a group-accessible OMO nonce store at mode %o and recovers when private", async mode => {
    useOmo(); chmodSync(sessionFile, 0o664); chmodSync(String(record.session_dir), mode);
    expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
    chmodSync(String(record.session_dir), 0o700);
    expect((await conversationForPane(pane)).source).toBe("omo-transcript");
  });

  it.each(["id", "cwd"] as const)("rejects an OMO header with a changed %s", async field => {
    useOmo(); chmodSync(sessionFile, 0o664);
    const header = field === "id" ? { type: "session", id: "changed-session", cwd: root } : { type: "session", id: sessionId, cwd: "/" };
    writeFileSync(sessionFile, JSON.stringify(header) + "\n");
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it("rejects out-of-store and symlinked OMO files even when their inode is pinned", async () => {
    useOmo(); chmodSync(sessionFile, 0o664);
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n", { mode: 0o664 });
    const outsideInfo = statSync(outside);
    record.session_file = outside; record.file_identity = { dev: outsideInfo.dev, ino: outsideInfo.ino }; save();
    expect((await resolve()).identity.reason).toBe("blocked_session_root");
    record.session_file = sessionFile; save(); rmSync(sessionFile); symlinkSync(outside, sessionFile);
    expect((await resolve()).identity.reason).toBe("blocked_session_root");
  });

  it.each(["stopped", "generation"] as const)("keeps an OMO %s mismatch blocked despite a valid group-write pin", async mismatch => {
    useOmo(); chmodSync(sessionFile, 0o664);
    if (mismatch === "stopped") record.desired_state = "stopped";
    else record.generation = 2;
    save();
    expect((await resolve()).identity.reason).toBe(mismatch === "stopped" ? "blocked_session_stopped" : "blocked_managed_generation");
  });

  it("rejects a cached OMO conversation after the pinned file is replaced", async () => {
    useOmo(); chmodSync(sessionFile, 0o664);
    expect((await conversationForPane(pane)).source).toBe("omo-transcript");
    const replacement = join(root, "replacement.jsonl");
    writeFileSync(replacement, [JSON.stringify({ type: "session", id: sessionId, cwd: root }), message("assistant", "replacement")].join("\n") + "\n", { mode: 0o664 });
    rmSync(sessionFile); renameSync(replacement, sessionFile);
    expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
    await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_replaced");
  });

  it("rejects a cached OMO conversation after its header is rewritten in place", async () => {
    useOmo(); chmodSync(sessionFile, 0o664);
    expect((await conversationForPane(pane)).source).toBe("omo-transcript");
    const before = statSync(sessionFile);
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "changed-session", cwd: root }) + "\n");
    const after = statSync(sessionFile);
    expect(after.dev).toBe(before.dev); expect(after.ino).toBe(before.ino);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_header");
  });
});

it("rejects out-of-store and subagent substitutions even with a matching filename", async () => {
  const outside = join(root, "outside.jsonl"); writeFileSync(outside, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n");
  record.session_file = outside; save(); expect((await resolve()).identity.reason).toBe("blocked_session_root");
  record.session_file = sessionFile; save(); rmSync(sessionFile); symlinkSync(outside, sessionFile); expect((await resolve()).identity.reason).toBe("blocked_session_root");
});

it("rejects a replaced generation's cursors even when it keeps the same exact file", async () => {
  const header = JSON.stringify({ type: "session", id: sessionId, cwd: root });
  writeFileSync(sessionFile, [header, ...Array.from({ length: 500 }, (_, i) => [message("user", `question ${i}`), message("assistant", `answer ${i}`)]).flat()].join("\n") + "\n");
  const first = await conversationForPane(pane); expect(first.cursor).toBeString();
  record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save();
  await expect(conversationForPane(pane, undefined, { before: first.cursor! })).rejects.toBeInstanceOf(HistoryChanged);
  const second = await conversationForPane(pane); expect(second.history_id).not.toBe(first.history_id); expect(second.version).not.toBe(first.version);
});

describe.each(["gjc", "omo", "codex", "claude"] as const)("%s exact managed transcript", harness => {
  it("validates that harness's native header without any latest-session lookup", async () => {
    record.harness = harness; record.launcher_harness = harness;
    if (harness === "codex" || harness === "claude") {
      const base = join(root, harness); mkdirSync(join(base, harness === "codex" ? "sessions" : "projects"), { recursive: true, mode: 0o700 });
      sessionFile = join(base, harness === "codex" ? "sessions" : "projects", "exact.jsonl"); record.env = { [harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: base };
    }
    const meta = harness === "codex" ? { type: "session_meta", payload: { id: sessionId, cwd: root } } : harness === "claude" ? { sessionId, cwd: root, type: "user" } : { type: "session", id: sessionId, cwd: root };
    writeFileSync(sessionFile, JSON.stringify(meta) + "\n", { mode: 0o600 }); const info = statSync(sessionFile);
    record.session_file = sessionFile; record.file_identity = { dev: info.dev, ino: info.ino }; save();
    expect((await resolve()).identity.state).toBe("ready"); expect(await resolveTranscript(pane, root)).toMatchObject({ source: `${harness}-transcript`, path: sessionFile });
  });

  it("allows group-write only for a pinned OMO transcript", async () => {
    sizedNativeHeader(harness, 1024);
    chmodSync(sessionFile, 0o664);
    const result = await resolve();
    expect(result.identity.state).toBe(harness === "omo" ? "ready" : "blocked");
    expect(result.identity.reason).toBe(harness === "omo" ? null : "blocked_session_replaced");
  });
});

/** Synthetic UTF-8 rows sized including their terminating newline, never a native session. */
function sizedNativeHeader(harness: "gjc" | "omo" | "codex" | "claude", bytes: number, identity: { id?: string; cwd?: string } = {}): string {
  record.harness = harness; record.launcher_harness = harness;
  if (harness === "codex" || harness === "claude") {
    const base = join(root, harness);
    const store = join(base, harness === "codex" ? "sessions" : "projects");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    sessionFile = join(store, "synthetic-header.jsonl");
    record.env = { [harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: base };
  }
  const id = identity.id ?? sessionId;
  const cwd = identity.cwd ?? root;
  const instructions = { text: "합성" };
  const meta = harness === "codex" ? { type: "session_meta", payload: { id, cwd, base_instructions: instructions } }
    : harness === "claude" ? { type: "user", sessionId: id, cwd, padding: instructions }
      : { type: "session", id, cwd, padding: instructions };
  instructions.text += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(meta) + "\n"));
  const row = JSON.stringify(meta) + "\n";
  writeFileSync(sessionFile, row, { mode: 0o600 });
  const info = statSync(sessionFile);
  record.session_file = sessionFile; record.file_identity = { dev: info.dev, ino: info.ino }; save();
  return row;
}

describe("finite native identity row bounds", () => {
  it.each([22796, 1024 * 1024])("accepts a synthetic %i-byte Codex session_meta row including newline", async bytes => {
    const row = sizedNativeHeader("codex", bytes);
    expect(Buffer.byteLength(row)).toBe(bytes);
    // An oversized, malformed body after the identity row must not be parsed as metadata.
    writeFileSync(sessionFile, row + "{".repeat(1024 * 1024 + 1));
    expect(await resolve()).toMatchObject({ identity: { state: "ready", harness: "codex", session_id: sessionId }, sessionFile });
  });

  it.each([1024 * 1024 + 1, 1024 * 1024 + 16385])("rejects a %i-byte Codex first row", async bytes => {
    sizedNativeHeader("codex", bytes);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it("requires the newline within the Codex bound and never skips a different first row", async () => {
    const row = sizedNativeHeader("codex", 1024 * 1024);
    writeFileSync(sessionFile, row.slice(0, -1));
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    writeFileSync(sessionFile, JSON.stringify({ type: "message" }) + "\n" + row);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it.each(["id", "cwd"] as const)("still rejects incorrect Codex %s beyond 16 KiB", async field => {
    sizedNativeHeader("codex", 22796, field === "id" ? { id: "synthetic-wrong-session" } : { cwd: "/" });
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it.each(["gjc", "omo", "claude"] as const)("keeps %s rows bounded to 16 KiB including newline", async harness => {
    sizedNativeHeader(harness, 16384);
    expect((await resolve()).identity.state).toBe("ready");
    for (const bytes of [16385, 22796]) {
      sizedNativeHeader(harness, bytes);
      expect((await resolve()).identity.reason).toBe("blocked_session_header");
    }
  });

  it("keeps Claude's prefix limited to 32 rows and 16 KiB per row", async () => {
    const header = sizedNativeHeader("claude", 16384);
    const prefix = (bytes: number) => JSON.stringify({ type: "file-history-snapshot", padding: "x".repeat(bytes - Buffer.byteLength(JSON.stringify({ type: "file-history-snapshot", padding: "" }) + "\n")) }) + "\n";
    writeFileSync(sessionFile, prefix(16384).repeat(31) + header);
    expect((await resolve()).identity.state).toBe("ready");
    writeFileSync(sessionFile, prefix(16384).repeat(32) + header);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    writeFileSync(sessionFile, prefix(16385) + header);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });
});
