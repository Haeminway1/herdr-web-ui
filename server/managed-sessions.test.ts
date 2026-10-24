import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationUnavailable, conversationForPane as readConversation, HistoryChanged, managedQuestionsForPane, readCommandTranscript, resolveTranscript as readTranscript } from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { labelManagedPanes as projectPanes, resolveManagedSession, type ManagedSessionDeps } from "./managed-sessions.ts";
import { gjcSdkCurrentSessionWithRunner, type GjcSdkCommandRunner, type GjcSdkSessionIdentity } from "./gjc-sdk.ts";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";
import { gjcSdkGenerationCurrent } from "./gjc-sdk-generation.ts";
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
  paneById: async () => pane,
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

it.each(["ENOENT", "EACCES", "EPERM", "BROKER", "EPIPE", "ECONNREFUSED", "ETIMEDOUT"].flatMap(code => [
  { code, savedSession: null },
  { code, savedSession: { id: sessionId } },
  { code, savedSession: { id: sessionId, path: "" } },
  { code, savedSession: { id: sessionId, path: "relative.jsonl" } },
  { code, savedSession: { id: "wrong-session", path: "/untrusted/saved.jsonl" } },
]))("keeps live managed identity independent of saved metadata during cached generation %j failures", async ({ code, savedSession }) => {
  let starts = 0, unavailable = false, current = true, observations = 0;
  const runner: GjcSdkCommandRunner = async () => {
    starts += 1;
    return JSON.stringify({ type: "broker_response", ok: true, result: {
      indexSeq: 1, savedSession, sessions: [{
        sessionId, pid: 42, hostIncarnation: "linux:123", endpointGeneration: 1,
        locator: { cwd: root, worktreeRoot: root, stateRoot: join(root, ".gjc", "state") },
        identityProvenance: "composite", terminalUncertain: false, ambiguous: false, terminal: false, live: true,
      }],
    } });
  };
  const sdkDeps: ManagedSessionDeps = { ...deps, gjcSession: (pids, cwd, agentDir) =>
    gjcSdkCurrentSessionWithRunner(pids, cwd, agentDir, runner, async () => root, () => 0,
      (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
        generationStatus: async (session, endpoint) => {
          observations += 1;
          expect([session, endpoint]).toEqual([sessionId, 1]);
          if (unavailable) throw Object.assign(new Error(`private SDK evidence ${sessionFile}`), { code });
          return { status: current ? "current" : "retired" };
        },
      })),
  };
  const resolve = () => resolveManagedSession(pane, namespace, sdkDeps);
  expect(await resolve()).toMatchObject({ identity: { state: "ready", session_id: sessionId }, sessionFile });
  unavailable = true;
  const reason = code === "ETIMEDOUT" ? "timeout" : "unavailable";
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, lookupError: { reason } });
  pane.agent_session = { agent: "codex", kind: "id", source: "provider-child", value: "stale-child" };
  const unrelated: HerdrPane = { ...pane, pane_id: "wFixture:unrelated", tokens: {} };
  const snapshot = { panes: [pane, unrelated], agents: [pane, unrelated], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const roster = await projectPanes(snapshot, namespace, sdkDeps);
  expect(roster.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending" } });
  expect(roster.agents[0]).toMatchObject({ agent: "gjc", agent_session: null });
  expect(roster.panes[1]).toBe(unrelated);
  expect(roster.agents[1]).toBe(unrelated);
  const failure = await readConversation(pane, undefined, undefined, sdkDeps).catch(error => error);
  expect(failure).toBeInstanceOf(GjcSdkLookupError);
  expect(failure).toMatchObject({ reason, message: "GJC SDK lookup failed" });
  expect(JSON.stringify(failure)).not.toContain(root);
  unavailable = false; current = false;
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, sessionFile: null });
  current = true;
  expect(await resolve()).toMatchObject({ identity: { state: "ready", session_id: sessionId }, sessionFile });
  expect(observations).toBe(6);
  expect(starts).toBe(2);
});

it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"].flatMap(code => [
  { code, savedSession: null },
  { code, savedSession: { id: sessionId } },
  { code, savedSession: { id: sessionId, path: "" } },
  { code, savedSession: { id: sessionId, path: "relative.jsonl" } },
  { code, savedSession: { id: "wrong-session", path: "/untrusted/sdk-session.jsonl" } },
  { code, savedSession: { id: sessionId, path: "/untrusted/sdk-session.jsonl" } },
]))("withholds cached managed history and questions after final proof $code with saved metadata $savedSession", async ({ code, savedSession }) => {
  let starts = 0, proofs = 0, failAt = Infinity;
  const runner: GjcSdkCommandRunner = async () => {
    starts += 1;
    return JSON.stringify({ type: "broker_response", ok: true, result: {
      indexSeq: 1, savedSession, sessions: [{
        sessionId, pid: 42, hostIncarnation: "linux:123", endpointGeneration: 1,
        locator: { cwd: root, worktreeRoot: root, stateRoot: join(root, ".gjc", "state") },
        identityProvenance: "composite", terminalUncertain: false, ambiguous: false, terminal: false, live: true,
      }],
    } });
  };
  const sdkDeps: ManagedSessionDeps = { ...deps, gjcSession: (pids, cwd, agentDir) =>
    gjcSdkCurrentSessionWithRunner(pids, cwd, agentDir, runner, async () => root, () => 0,
      (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
        generationStatus: async (session, endpoint) => {
          expect([session, endpoint]).toEqual([sessionId, 1]);
          if (++proofs === failAt) throw Object.assign(new Error(`private final proof ${sessionFile}`), { code });
          return { status: "current" };
        },
      })),
  };
  pane.agent_session = { agent: "codex", kind: "id", source: "provider-child", value: "stale-child" };
  const read = () => readConversation(pane, undefined, undefined, sdkDeps);
  const first = await read();
  expect(first.turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(proofs).toBe(2);
  failAt = proofs + 2;
  const failure = await read().catch(error => error);
  expect(proofs).toBe(failAt);
  expect(failure).toBeInstanceOf(GjcSdkLookupError);
  expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
  expect(JSON.stringify(failure)).not.toContain(root);
  failAt = Infinity;
  const recovered = await read();
  expect(recovered.history_id).toBe(first.history_id);
  expect(recovered.turns).toEqual(first.turns);
  expect(recovered.managed_session).toMatchObject({ state: "ready", harness: "gjc", session_id: sessionId });
  const questions = await managedQuestionsForPane(pane, sdkDeps);
  expect(questions.identity).toStartWith(`managed-${nonce}-1:${sessionId}:`);
  failAt = proofs + 2;
  const questionFailure = await managedQuestionsForPane(pane, sdkDeps).catch(error => error);
  expect(proofs).toBe(failAt);
  expect(questionFailure).toBeInstanceOf(GjcSdkLookupError);
  expect(questionFailure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
  expect(JSON.stringify(questionFailure)).not.toContain(root);
  failAt = Infinity;
  expect(await managedQuestionsForPane(pane, sdkDeps)).toEqual(questions);
  expect(starts).toBe(2);
});

it.each(["retired", "replaced", "unknown"].flatMap(revoked => [
  { revoked, savedSession: null },
  { revoked, savedSession: { id: sessionId } },
  { revoked, savedSession: { id: sessionId, path: "relative.jsonl" } },
  { revoked, savedSession: { id: "wrong-session", path: "/untrusted/saved.jsonl" } },
]))("withholds warm managed chat and provider authority after generation becomes $revoked with saved metadata $savedSession", async ({ revoked, savedSession }) => {
  let starts = 0, status = "current";
  const runner: GjcSdkCommandRunner = async () => {
    starts += 1;
    return JSON.stringify({ type: "broker_response", ok: true, result: {
      indexSeq: 1, savedSession, sessions: [{
        sessionId, pid: 42, hostIncarnation: "linux:123", endpointGeneration: 1,
        locator: { cwd: root, worktreeRoot: root, stateRoot: join(root, ".gjc", "state") },
        identityProvenance: "composite", terminalUncertain: false, ambiguous: false, terminal: false, live: true,
      }],
    } });
  };
  const sdkDeps: ManagedSessionDeps = { ...deps, gjcSession: (pids, cwd, agentDir) =>
    gjcSdkCurrentSessionWithRunner(pids, cwd, agentDir, runner, async () => root, () => 0,
      (directory, id, generation) => gjcSdkGenerationCurrent(directory, id, generation, {
        generationStatus: async () => ({ status }),
      })),
  };
  pane.agent_session = { agent: "codex", kind: "id", source: "provider-child", value: "stale-child" };
  const unrelated: HerdrPane = { ...pane, pane_id: "wFixture:unrelated", tokens: {} };
  const snapshot = { panes: [pane, unrelated], agents: [pane, unrelated], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const read = () => readConversation(pane, undefined, undefined, sdkDeps);
  const first = await read();
  expect(first.turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  status = revoked;
  await expect(read()).rejects.toMatchObject({ name: "ConversationUnavailable", message: "identity_pending" });
  const roster = await projectPanes(snapshot, namespace, sdkDeps);
  expect(roster.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending", session_id: null } });
  expect(roster.agents[0]).toMatchObject({ agent: "gjc", agent_session: null });
  expect(roster.panes[1]).toBe(unrelated);
  expect(roster.agents[1]).toBe(unrelated);
  status = "current";
  const recovered = await read();
  expect(recovered.history_id).toBe(first.history_id);
  expect(recovered.turns).toEqual(first.turns);
  expect(starts).toBe(2);
});

describe("managed command evidence", () => {
  let snapshot: ReturnType<typeof spyOn<typeof client, "sessionSnapshot">>;
  beforeEach(() => {
    snapshot = spyOn(client, "sessionSnapshot").mockImplementation(async () => ({
      panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [], protocol: 22, version: "fixture",
    }));
  });
  afterEach(() => snapshot.mockRestore());
  const read = () => readCommandTranscript(pane.pane_id, undefined, deps);

  it("scopes cached native command records to the managed generation", async () => {
    fs.appendFileSync(sessionFile, JSON.stringify({ type: "model_change", modelId: "fixture-model" }) + "\n");
    const first = await read();
    expect(first?.records.some(({ entry }) => entry.modelId === "fixture-model")).toBe(true);
    expect(await read()).toBe(first);
    record.generation = 2; pane.tokens!.hm_managed_generation = "2"; save();
    const second = await read();
    expect(second?.identity).not.toBe(first?.identity);
    expect(second?.identity).toStartWith(`gjc-transcript\0${sessionFile}\0managed-${nonce}-2:`);
  });

  it("never reads an inode swapped in just for the command-content open", async () => {
    const replacement = join(String(record.session_dir), "replacement.jsonl");
    const held = join(String(record.session_dir), "held.jsonl");
    writeFileSync(replacement, JSON.stringify({ type: "model_change", modelId: "unauthorized" }) + "\n", { mode: 0o600 });
    const originalOpen = fs.openSync;
    let opens = 0;
    let swapped = false;
    const intercepted = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === sessionFile && ++opens === 3) {
        renameSync(sessionFile, held); renameSync(replacement, sessionFile);
        try { return Reflect.apply(originalOpen, fs, [path, ...args]); }
        finally { renameSync(sessionFile, replacement); renameSync(held, sessionFile); swapped = true; }
      }
      return Reflect.apply(originalOpen, fs, [path, ...args]);
    }) as typeof fs.openSync);
    try {
      await expect(read()).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable" });
      expect(swapped).toBe(true);
    } finally { intercepted.mockRestore(); }
    expect((await read())?.records.some(({ entry }) => entry.modelId === "unauthorized")).toBe(false);
  });

  it.each([false, true])("rechecks managed authority after command evidence, including a cache hit: %s", async cached => {
    if (cached) await read();
    let validations = 0;
    const changedDeps: ManagedSessionDeps = { ...deps, gjcSession: async () => {
      if (++validations === 2) { record.generation = 2; save(); }
      return live;
    } };
    await expect(readCommandTranscript(pane.pane_id, undefined, changedDeps)).rejects.toMatchObject({
      name: "ConversationUnavailable", message: "blocked_managed_identity_changed",
    });
    expect(validations).toBe(2);
  });

  it.each([false, true])("withholds command evidence after pane reassignment during the final SDK proof, cached: %s", async cached => {
    if (cached) await read();
    const currentPane = structuredClone(pane);
    let lookups = 0;
    const changedDeps: ManagedSessionDeps = {
      ...deps,
      paneById: async () => structuredClone(currentPane),
      gjcSession: async () => {
        if (++lookups === 2) currentPane.tokens!.hm_managed_generation = "2";
        return live;
      },
    };
    await expect(readCommandTranscript(pane.pane_id, undefined, changedDeps)).rejects.toMatchObject({
      name: "ConversationUnavailable", message: "blocked_managed_identity_changed",
    });
    expect(lookups).toBe(2);
    expect(record.generation).toBe(1);
  });

  it.each(["ENOENT", "EACCES", "EIO"])("propagates a command-content %s failure without clearing chat", async code => {
    const originalOpen = fs.openSync;
    let opens = 0;
    const denied = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === sessionFile && ++opens === 3) throw Object.assign(new Error(`private ${sessionFile}`), { code });
      return Reflect.apply(originalOpen, fs, [path, ...args]);
    }) as typeof fs.openSync);
    try {
      const failure = await read().catch(error => error);
      expect(failure).toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(root);
    } finally { denied.mockRestore(); }
    expect((await conversationForPane(pane)).turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  });
});

it.each([
  new Error("private GJC SDK exception"), "private GJC SDK rejection",
  Object.assign(new Error("private GJC SDK missing"), { code: "ENOENT" }),
  Object.assign(new Error("private GJC SDK denied"), { code: "EACCES" }),
  Object.assign(new Error("private GJC SDK broker failed"), { code: "BROKER" }),
  Object.assign(new Error("private GJC SDK timed out"), { code: "ETIMEDOUT" }),
  new GjcSdkLookupError("timeout"), new GjcSdkLookupError("unavailable"),
] as const)("isolates a managed SDK rejection to its pane", async rejection => {
  const failedNonce = "f".repeat(32);
  const failedPane: HerdrPane = {
    ...pane,
    pane_id: "wFailed:p1",
    workspace_id: "wFailed",
    tab_id: "wFailed:t1",
    terminal_id: "term_failed",
    agent_session: { agent: "codex", kind: "id", source: "provider-child", value: "provider-child-session" },
    tokens: { hm_managed_session: failedNonce, hm_managed_generation: "1" },
  };
  const failedDirectory = join(namespace, `${failedNonce}.sessions`);
  mkdirSync(failedDirectory, { mode: 0o700 });
  const failedSessionFile = join(failedDirectory, "exact.jsonl");
  writeFileSync(failedSessionFile, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n", { mode: 0o600 });
  const failedInfo = statSync(failedSessionFile);
  const failedChild = { pid: 43, starttime: "456", boot: "fixture-boot", cwd: root };
  writeFileSync(join(namespace, `${failedNonce}.json`), JSON.stringify({
    ...record,
    nonce: failedNonce,
    pane_id: failedPane.pane_id,
    workspace_id: failedPane.workspace_id,
    terminal_id: failedPane.terminal_id,
    session_file: failedSessionFile,
    session_dir: failedDirectory,
    file_identity: { dev: failedInfo.dev, ino: failedInfo.ino },
    child: failedChild,
  }), { mode: 0o600 });

  const unmanagedPane: HerdrPane = {
    ...pane,
    pane_id: "wUnmanaged:p1",
    workspace_id: "wUnmanaged",
    terminal_id: "term_unmanaged",
    agent_session: { agent: "codex", kind: "id", source: "provider-child", value: "unmanaged-provider-session" },
    tokens: {},
  };
  const snapshot: SessionSnapshot = {
    panes: [pane, failedPane, unmanagedPane],
    agents: [pane, failedPane, unmanagedPane],
    workspaces: [],
    tabs: [],
    layouts: [],
    protocol: 22,
    version: "fixture",
  };
  const failedDeps: ManagedSessionDeps = {
    ...deps,
    processIdentity: pid => pid === 42 ? observed : pid === failedChild.pid ? failedChild : null,
    gjcSession: async pids => {
      if (pids.includes(failedChild.pid)) return Promise.reject(rejection);
      return live;
    },
  };

  const projected = await projectPanes(snapshot, namespace, failedDeps);
  const failed = projected.panes.find(entry => entry.pane_id === failedPane.pane_id);
  expect(projected.panes[0]).toMatchObject({ managed_session: { state: "ready", session_id: sessionId }, agent_session: { source: "herdr-manager", value: sessionId } });
  expect((await readConversation(pane, undefined, undefined, failedDeps)).turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(failed).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending", reason: "identity_pending", session_id: null } });
  expect(projected.panes[2]).toEqual(unmanagedPane);
  expect(projected.agents[1]?.agent_session).toBeNull();
  expect(projected.agents[2]?.agent_session).toEqual(unmanagedPane.agent_session);
  expect(JSON.stringify(projected)).not.toContain("private GJC SDK");
  const reason = rejection instanceof GjcSdkLookupError ? rejection.reason
    : rejection instanceof Error && "code" in rejection && rejection.code === "ETIMEDOUT" ? "timeout" : "unavailable";
  expect(await resolveManagedSession(failedPane, namespace, failedDeps)).toMatchObject({
    identity: { state: "identity_pending" }, lookupError: { reason, message: "GJC SDK lookup failed" },
  });
  await expect(readConversation(failedPane, undefined, undefined, failedDeps)).rejects.toMatchObject({
    name: "GjcSdkLookupError", reason, message: "GJC SDK lookup failed",
  });
});

it.each(["timeout", "unavailable"] as const)("retains a typed %s broker failure on a pending identity", async reason => {
  const failure = new GjcSdkLookupError(reason);
  const result = await resolveManagedSession(pane, namespace, { ...deps, gjcSession: async () => { throw failure; } });
  expect(result).toMatchObject({ identity: { state: "identity_pending", session_id: null }, sessionFile: null });
  expect(result?.lookupError).toBe(failure);
});

for (const code of ["ENOENT", "EACCES"]) it.skipIf(process.platform !== "linux")(`keeps production process identity ${code} failures typed and pending`, async () => {
  const stat = fs.statSync;
  const denied = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (path === "/proc/42") throw Object.assign(new Error("private process evidence"), { code });
    return Reflect.apply(stat, fs, [path, ...args]);
  }) as typeof fs.statSync);
  const productionDeps = { ...deps, processIdentity: undefined };
  pane.agent_session = { agent: "codex", kind: "id", source: "provider-child", value: "stale-provider-session" };
  try {
    expect(await resolveManagedSession(pane, namespace, productionDeps)).toMatchObject({
      identity: { state: "identity_pending", session_id: null }, sessionFile: null,
      lookupError: { reason: "unavailable", message: "GJC SDK lookup failed" },
    });
    const snapshot = { panes: [pane], agents: [pane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
    const projected = await projectPanes(snapshot, namespace, productionDeps);
    expect(projected.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending" } });
    expect(projected.agents[0]?.agent_session).toBeNull();
    expect(JSON.stringify(projected)).not.toContain("private process evidence");
    await expect(readConversation(pane, undefined, undefined, productionDeps)).rejects.toMatchObject({
      name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed",
    });
  } finally { denied.mockRestore(); }
  expect((await resolve()).identity.state).toBe("ready");
});

it.each([
  { code: "timeout", reason: "timeout", typed: true },
  { code: "unavailable", reason: "unavailable", typed: true },
  { code: "ENOENT", reason: "unavailable", typed: false },
  { code: "EACCES", reason: "unavailable", typed: false },
  { code: "BROKER", reason: "unavailable", typed: false },
  { code: "EPIPE", reason: "unavailable", typed: false },
  { code: "ECONNREFUSED", reason: "unavailable", typed: false },
  { code: "ETIMEDOUT", reason: "timeout", typed: false },
] as const)("keeps a $code SDK failure pending and isolates the whole roster", async ({ code, reason, typed }) => {
  const failedNonce = "f".repeat(32);
  const failedPane: HerdrPane = {
    ...pane,
    pane_id: "wFailed:p1",
    workspace_id: "wFailed",
    terminal_id: "term_failed",
    agent_session: { agent: "codex", kind: "id", source: "provider-child", value: "stale-child" },
    tokens: { hm_managed_session: failedNonce, hm_managed_generation: "1" },
  };
  const failedDirectory = join(namespace, `${failedNonce}.sessions`);
  mkdirSync(failedDirectory, { mode: 0o700 });
  const failedFile = join(failedDirectory, "exact.jsonl");
  writeFileSync(failedFile, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n", { mode: 0o600 });
  const info = statSync(failedFile);
  const child = { pid: 43, starttime: "456", boot: "fixture-boot", cwd: root };
  writeFileSync(join(namespace, `${failedNonce}.json`), JSON.stringify({
    ...record, nonce: failedNonce, pane_id: failedPane.pane_id, workspace_id: failedPane.workspace_id,
    terminal_id: failedPane.terminal_id, session_file: failedFile, session_dir: failedDirectory,
    file_identity: { dev: info.dev, ino: info.ino }, child,
  }), { mode: 0o600 });
  const failedDeps: ManagedSessionDeps = {
    ...deps,
    processIdentity: pid => pid === 42 ? observed : pid === 43 ? child : null,
    gjcSession: async pids => {
      if (pids.includes(43)) throw typed ? new GjcSdkLookupError(reason) : Object.assign(new Error(`private broker ${failedFile}`), { code });
      return live;
    },
  };
  const snapshot = { panes: [pane, failedPane], agents: [pane, failedPane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const result = await projectPanes(snapshot, namespace, failedDeps);
  expect(result.panes[0]).toMatchObject({ managed_session: { state: "ready" }, agent_session: { source: "herdr-manager", value: sessionId } });
  expect(result.panes[1]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending", reason: "identity_pending", session_id: null } });
  expect(result.agents[1]).toMatchObject({ agent: "gjc", agent_session: null });
  expect((await resolveManagedSession(failedPane, namespace, failedDeps))?.identity.state).toBe("identity_pending");
  await expect(readConversation(failedPane, undefined, undefined, failedDeps)).rejects.toMatchObject({
    name: "GjcSdkLookupError", reason, message: "GJC SDK lookup failed",
  });
  expect(JSON.stringify(result)).not.toContain("private broker");
  expect(JSON.stringify(result)).not.toContain(failedFile);
  expect(JSON.stringify(result)).not.toContain("stale-child");
});

it.each(["ENOENT", "EACCES", "EIO"])("keeps trusted record and transcript %s reads pending without provider authority", async (code) => {
  for (const target of [recordFile, sessionFile]) {
    const open = fs.openSync;
    const denied = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === target) throw Object.assign(new Error(`private ${target}`), { code });
      return Reflect.apply(open, fs, [path, ...args]);
    }) as typeof fs.openSync);
    try {
      const snapshot = { panes: [pane], agents: [pane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
      const result = await labelManagedPanes(snapshot);
      expect(result.panes[0]).toMatchObject({ agent_session: null, managed_session: { state: "identity_pending", session_id: null } });
      expect(result.agents[0]?.agent_session).toBeNull();
      expect(JSON.stringify(result)).not.toContain(target);
      expect(await resolve()).toMatchObject({ lookupError: { reason: "unavailable", message: "GJC SDK lookup failed" } });
      await expect(conversationForPane(pane)).rejects.toMatchObject({
        name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed",
      });
    } finally { denied.mockRestore(); }
    expect((await resolve()).identity.state).toBe("ready");
  }
});

it.each(["ENOENT", "EACCES", "EIO"])("keeps post-validation paging %s failures typed and recoverable", async code => {
  for (const phase of ["stat", "stream"]) {
    fs.appendFileSync(sessionFile, "\n");
    let validations = 0;
    const countedDeps: ManagedSessionDeps = { ...deps, gjcSession: async () => { validations += 1; return live; } };
    const failure = () => Object.assign(new Error(`private ${sessionFile}`), { code });
    const stat = fs.fstatSync;
    const read = fs.readSync;
    let stats = 0;
    let contentFd = -1;
    let failed = false;
    const deniedStat = spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      // Two record and two header descriptors precede the held GJC content descriptor.
      if (++stats === 5) {
        contentFd = fd;
        if (phase === "stat") { failed = true; throw failure(); }
      }
      return Reflect.apply(stat, fs, [fd, ...args]);
    }) as typeof fs.fstatSync);
    const deniedRead = spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      if (fd === contentFd && !failed) { failed = true; throw failure(); }
      return Reflect.apply(read, fs, [fd, ...args]);
    }) as typeof fs.readSync);
    try {
      const rejected = await readConversation(pane, undefined, undefined, countedDeps).catch(error => error);
      expect(rejected).toBeInstanceOf(GjcSdkLookupError);
      expect(rejected).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(rejected)).not.toContain(root);
      expect(validations).toBe(2);
      expect(failed).toBe(true);
    } finally { deniedRead.mockRestore(); deniedStat.mockRestore(); }
    expect((await conversationForPane(pane)).turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  }
});

it("does not hide a generation revocation behind a transient paging error", async () => {
  const open = fs.openSync;
  let headers = 0;
  const denied = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === sessionFile && ++headers === 3) {
      record.generation = 2; save();
      throw Object.assign(new Error("private paging failure"), { code: "EACCES" });
    }
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync);
  try {
    await expect(conversationForPane(pane)).rejects.toMatchObject({
      name: "ConversationUnavailable", message: "blocked_managed_identity_changed", managedSession: { state: "blocked", reason: "blocked_managed_generation" },
    });
  } finally { denied.mockRestore(); }
});

it("keeps a missing transcript pending without affecting another managed pane", async () => {
  const failedNonce = "e".repeat(32);
  const failedPane: HerdrPane = {
    ...pane, pane_id: "wMissing:p1", workspace_id: "wMissing", terminal_id: "term_missing",
    agent_session: { agent: "codex", kind: "id", source: "provider-child", value: "stale-provider-child" },
    tokens: { hm_managed_session: failedNonce, hm_managed_generation: "1" },
  };
  const failedDirectory = join(namespace, `${failedNonce}.sessions`);
  mkdirSync(failedDirectory, { mode: 0o700 });
  const failedFile = join(failedDirectory, "exact.jsonl");
  writeFileSync(failedFile, JSON.stringify({ type: "session", id: sessionId, cwd: root }) + "\n", { mode: 0o600 });
  const info = statSync(failedFile);
  const pinnedIdentity = { dev: info.dev, ino: info.ino };
  const failedChild = { pid: 43, starttime: "456", boot: "fixture-boot", cwd: root };
  writeFileSync(join(namespace, `${failedNonce}.json`), JSON.stringify({
    ...record, nonce: failedNonce, pane_id: failedPane.pane_id, workspace_id: failedPane.workspace_id,
    terminal_id: failedPane.terminal_id, session_file: failedFile, session_dir: failedDirectory,
    file_identity: pinnedIdentity, child: failedChild,
  }), { mode: 0o600 });
  const failedDeps: ManagedSessionDeps = {
    ...deps,
    processIdentity: pid => pid === 42 ? observed : pid === 43 ? failedChild : null,
    gjcSession: async pids => pids.includes(43) ? { ...live!, pid: 43, hostIncarnation: "linux:456" } : live,
  };
  const snapshot = { panes: [pane, failedPane], agents: [pane, failedPane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const movedFile = join(failedDirectory, "held.jsonl");
  renameSync(failedFile, movedFile);
  try {
    const pending = await resolveManagedSession(failedPane, namespace, failedDeps);
    expect(pending).toMatchObject({ identity: { state: "identity_pending", reason: "identity_pending", session_id: null }, sessionFile: null });
    const projected = await projectPanes(snapshot, namespace, failedDeps);
    expect(projected.panes[0]).toMatchObject({ managed_session: { state: "ready", session_id: sessionId }, agent_session: { source: "herdr-manager", value: sessionId } });
    expect((await readConversation(pane, undefined, undefined, failedDeps)).turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
    expect(projected.panes[1]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending", reason: "identity_pending", session_id: null } });
    expect(projected.agents[1]).toMatchObject({ agent: "gjc", agent_session: null });
    let rejection: unknown;
    try { await readConversation(failedPane, undefined, undefined, failedDeps); } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(GjcSdkLookupError);
    expect(rejection).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
    expect(JSON.stringify(rejection)).not.toContain(root);
    expect(JSON.stringify(projected)).not.toContain(failedFile);
    expect(JSON.stringify(projected)).not.toContain("stale-provider-child");
  } finally {
    renameSync(movedFile, failedFile);
  }
  expect(statSync(failedFile)).toMatchObject(pinnedIdentity);
  expect(await resolveManagedSession(failedPane, namespace, failedDeps)).toMatchObject({ identity: { state: "ready", session_id: sessionId }, sessionFile: failedFile });
  expect((await projectPanes(snapshot, namespace, failedDeps)).panes[1]).toMatchObject({ managed_session: { state: "ready" }, agent_session: { source: "herdr-manager", value: sessionId } });
  rmSync(recordFile);
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, lookupError: { reason: "unavailable" } });
});

it("keeps an initial missing transcript or record pending without claiming absence", async () => {
  rmSync(sessionFile);
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending", session_id: null }, sessionFile: null, lookupError: { reason: "unavailable" } });
  rmSync(recordFile);
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, lookupError: { reason: "unavailable" } });
});

it("leaves unmanaged snapshots untouched without reading unrelated agent projections", async () => {
  const direct = { panes: [{ ...pane, tokens: {} }] } as SessionSnapshot;
  expect(await labelManagedPanes(direct)).toBe(direct);
});

it.each(["invalid", 42, false, [], Object.assign([], { hm_managed_session: nonce, hm_managed_generation: "1" })])("blocks malformed runtime tokens without trusting their contents: %j", async tokens => {
  const malformed = { ...pane, tokens } as unknown as HerdrPane;
  expect(await resolveManagedSession(malformed, namespace, deps)).toEqual({
    identity: { id: null, harness: null, generation: null, state: "blocked", reason: "blocked_managed_token", session_id: null },
    sessionFile: null,
  });
});

it("isolates malformed tokens in a mixed roster and denies provider child conversation fallback", async () => {
  const malformed = { ...pane, pane_id: "wFixture:malformed", agent_session: { agent: "codex", kind: "id", source: "provider", value: "provider-child" }, tokens: Object.assign([], { hm_managed_session: nonce, hm_managed_generation: "1" }) } as unknown as HerdrPane;
  const unrelated = { ...pane, pane_id: "wFixture:unrelated", tokens: {}, agent_session: { agent: "codex", kind: "id", source: "provider", value: "unrelated" } } as unknown as HerdrPane;
  const snapshot = { panes: [malformed, pane, unrelated], agents: [{ ...malformed }, { ...pane }, { ...unrelated }], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const projected = await labelManagedPanes(snapshot);
  expect(projected.panes[0]).toMatchObject({ agent: null, agent_session: null, managed_session: { id: null, harness: null, generation: null, state: "blocked", reason: "blocked_managed_token", session_id: null } });
  expect(projected.agents[0]).toMatchObject({ agent: null, agent_session: null });
  expect(projected.panes[1]).toMatchObject({ agent: "gjc", agent_session: { value: sessionId }, managed_session: { state: "ready" } });
  expect(projected.agents[1]).toMatchObject({ agent: "gjc", agent_session: { value: sessionId } });
  expect(projected.panes[2]).toEqual(unrelated);
  expect(projected.agents[2]).toEqual(snapshot.agents[2]);
  expect(JSON.stringify(projected.panes[0]!.managed_session)).not.toContain("provider-child");
  await expect(conversationForPane(projected.panes[0]!)).rejects.toMatchObject({
    name: "ConversationUnavailable", message: "blocked_managed_token", managedSession: { state: "blocked", reason: "blocked_managed_token" },
  });
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

describe("managed OMO title-prefixed headers", () => {
  const title = JSON.stringify({ type: "title", title: "Fixture session" }) + "\n";

  it.each([0o600, 0o664])("reads the exact pinned session after one title row with mode %o", async mode => {
    useOmo();
    writeFileSync(sessionFile, title + readFileSync(sessionFile, "utf8"));
    chmodSync(sessionFile, mode);
    expect(await resolve()).toMatchObject({ identity: { state: "ready", harness: "omo", session_id: sessionId }, sessionFile });
    expect((await omoPanes([pane])).get(pane.pane_id)?.path).toBe(sessionFile);
    const answer = await conversationForPane(pane);
    expect(answer.turns.flatMap(turn => turn.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
    expect(answer.history_id).toStartWith(`managed-${nonce}-1:`);
  });

  it.each(["id", "cwd"] as const)("rejects a mismatched %s in the session after the title", async field => {
    useOmo();
    writeFileSync(sessionFile, title + JSON.stringify({ type: "session", id: sessionId, cwd: root, [field]: field === "id" ? "wrong-session" : "/" }) + "\n");
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_header");
  });

  it.each(["title", "message"])("never skips a second %s row to find a later session", async type => {
    useOmo();
    writeFileSync(sessionFile, title + JSON.stringify({ type }) + "\n" + readFileSync(sessionFile, "utf8"));
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it("keeps the title and session rows individually bounded and newline-terminated", async () => {
    useOmo();
    const session = readFileSync(sessionFile, "utf8");
    const prefix = (bytes: number) => JSON.stringify({ type: "title", title: "x".repeat(bytes - Buffer.byteLength(JSON.stringify({ type: "title", title: "" }) + "\n")) }) + "\n";
    writeFileSync(sessionFile, prefix(16384) + session);
    expect((await resolve()).identity.state).toBe("ready");
    writeFileSync(sessionFile, prefix(16385) + session);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    writeFileSync(sessionFile, title);
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
    writeFileSync(sessionFile, title + JSON.stringify({ type: "session", id: sessionId, cwd: root }));
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });

  it("does not permit a title prefix for managed GJC", async () => {
    writeFileSync(sessionFile, title + readFileSync(sessionFile, "utf8"));
    expect((await resolve()).identity.reason).toBe("blocked_session_header");
  });
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

it("waits for a persisted GJC inode pin without upgrading recovery metadata", async () => {
  record.schema = 1; delete record.file_identity; save();
  const original = readFileSync(recordFile, "utf8");
  expect(await resolve()).toMatchObject({ identity: { harness: "gjc", state: "identity_pending", session_id: null }, sessionFile: null });
  await expect(resolveTranscript(pane, root)).rejects.toThrow("identity_pending");
  await expect(conversationForPane(pane)).rejects.toThrow("identity_pending");
  expect(readFileSync(recordFile, "utf8")).toBe(original);
  pinCurrentFile();
  const pinnedRecord = readFileSync(recordFile, "utf8");
  expect((await conversationForPane(pane)).turns.flatMap(t => t.parts)).toContainEqual({ kind: "text", text: "exact managed answer" });
  expect(readFileSync(recordFile, "utf8")).toBe(pinnedRecord);
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

it.each(["unavailable", "timeout"] as const)("keeps managed SDK %s pending without authorizing its provider child", async reason => {
  const unavailableDeps: ManagedSessionDeps = {
    ...deps,
    gjcSession: async () => { throw new GjcSdkLookupError(reason); },
  };
  const snapshot = { panes: [pane], agents: [pane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  expect(await resolveManagedSession(pane, namespace, unavailableDeps)).toMatchObject({
    identity: { harness: "gjc", state: "identity_pending", reason: "identity_pending", session_id: null },
    sessionFile: null,
  });
  const projected = await projectPanes(snapshot, namespace, unavailableDeps);
  expect(projected.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending" } });
  expect(projected.agents[0]?.agent_session).toBeNull();
  await expect(readConversation(pane, undefined, undefined, unavailableDeps)).rejects.toMatchObject({
    name: "GjcSdkLookupError", reason, message: "GJC SDK lookup failed",
  });
});

it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("isolates raw SDK %s in a mixed roster and recovers the same history", async code => {
  const healthy = { ...pane, pane_id: "wHealthy:p1", workspace_id: "wHealthy", terminal_id: "term_healthy", tokens: { ...pane.tokens, hm_managed_session: "a".repeat(32) } };
  const healthyDirectory = join(namespace, `${healthy.tokens.hm_managed_session}.sessions`);
  mkdirSync(healthyDirectory, { mode: 0o700 });
  const healthyFile = join(healthyDirectory, "exact.jsonl");
  writeFileSync(healthyFile, readFileSync(sessionFile), { mode: 0o600 });
  const healthyInfo = statSync(healthyFile);
  writeFileSync(join(namespace, `${healthy.tokens.hm_managed_session}.json`), JSON.stringify({
    ...record, nonce: healthy.tokens.hm_managed_session, pane_id: healthy.pane_id,
    workspace_id: healthy.workspace_id, terminal_id: healthy.terminal_id,
    session_file: healthyFile, session_dir: healthyDirectory,
    file_identity: { dev: healthyInfo.dev, ino: healthyInfo.ino },
    child: { ...observed, pid: 43 },
  }), { mode: 0o600 });
  pane.agent_session = { agent: "codex", kind: "id", source: "provider", value: "denied-child" };
  let failing = false;
  const mixedDeps: ManagedSessionDeps = {
    ...deps,
    processIdentity: pid => observed && (pid === 42 || pid === 43) ? { ...observed, pid } : null,
    paneById: async id => id === healthy.pane_id ? healthy : pane,
    gjcSession: async pids => {
      if (failing && pids.includes(42)) throw Object.assign(new Error(`private broker ${root}`), { code });
      return live ? { ...live, pid: pids[0]! } : null;
    },
  };
  const before = await readConversation(pane, undefined, undefined, mixedDeps);
  failing = true;
  const snapshot = { panes: [pane, healthy], agents: [pane, healthy], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const projected = await projectPanes(snapshot, namespace, mixedDeps);
  expect(projected.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending", session_id: null } });
  expect(projected.agents[0]?.agent_session).toBeNull();
  expect(projected.panes[1]).toMatchObject({ agent_session: { source: "herdr-manager", value: sessionId }, managed_session: { state: "ready" } });
  expect(projected.agents[1]?.agent_session?.value).toBe(sessionId);
  const failure = await readConversation(pane, undefined, undefined, mixedDeps).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(GjcSdkLookupError);
  expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
  expect(JSON.stringify(failure)).not.toContain(root);
  expect(JSON.stringify(projected)).not.toContain("denied-child");
  expect((await readConversation(healthy, undefined, undefined, mixedDeps)).turns).toEqual(before.turns);
  failing = false;
  const recovered = await readConversation(pane, undefined, undefined, mixedDeps);
  expect(recovered.history_id).toBe(before.history_id);
  expect(recovered.turns).toEqual(before.turns);
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

it.each(["nonce", "generation", "terminal", "workspace", "cwd", "removed"])("rejects pane %s reassignment during the final SDK proof", async change => {
  let currentPane: HerdrPane | null = structuredClone(pane);
  let lookups = 0;
  const racingDeps: ManagedSessionDeps = {
    ...deps,
    paneById: async () => structuredClone(currentPane),
    gjcSession: async () => {
      if (++lookups === 2) {
        if (change === "removed") currentPane = null;
        else if (change === "nonce") currentPane!.tokens!.hm_managed_session = "f".repeat(32);
        else if (change === "generation") currentPane!.tokens!.hm_managed_generation = "2";
        else if (change === "terminal") currentPane!.terminal_id = "replacement-terminal";
        else if (change === "workspace") currentPane!.workspace_id = "replacement-workspace";
        else currentPane!.cwd = "/";
      }
      return live;
    },
  };
  await expect(readConversation(pane, undefined, {}, racingDeps)).rejects.toMatchObject({
    name: "ConversationUnavailable", message: "blocked_managed_identity_changed",
  });
  expect(lookups).toBe(2);
});

it.each(["ENOENT", "EACCES", "BROKER"])("keeps a final pane read %s failure after the SDK proof typed and sanitized", async code => {
  let reads = 0;
  const failingDeps: ManagedSessionDeps = {
    ...deps,
    paneById: async () => {
      if (++reads === 2) throw Object.assign(new Error(`private final pane evidence ${sessionFile}`), { code });
      return structuredClone(pane);
    },
  };
  const failure = await readConversation(pane, undefined, {}, failingDeps).catch(error => error);
  expect(failure).toBeInstanceOf(GjcSdkLookupError);
  expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
  expect(JSON.stringify(failure)).not.toContain(root);
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
  expect(await resolve()).toMatchObject({ identity: { state: "identity_pending" }, lookupError: { reason: "unavailable" } });
  writeFileSync(recordFile, " ".repeat(65537)); expect((await resolve()).identity.reason).toBe("blocked_record_owner");
  writeFileSync(recordFile, original); chmodSync(recordFile, 0o666); expect((await resolve()).identity.reason).toBe("blocked_record_owner");
  rmSync(recordFile); const outside = join(root, "record.json"); writeFileSync(outside, original); symlinkSync(outside, recordFile);
  expect((await resolve()).identity.state).toBe("blocked");
});

it("accepts owner-controlled common parents without allowing writable authority records", async () => {
  chmodSync(root, 0o770);
  expect((await resolve()).identity.state).toBe("ready");
  chmodSync(namespace, 0o770);
  expect((await resolve()).identity.reason).toBe("blocked_record_root");
});

it("rejects a non-sticky world-writable ancestor", async () => {
  chmodSync(root, 0o777);
  expect((await resolve()).identity.reason).toBe("blocked_record_root");
});

it("rejects a symlinked managed record namespace", async () => {
  const movedNamespace = join(root, "managed-sessions-original");
  renameSync(namespace, movedNamespace);
  symlinkSync(movedNamespace, namespace, process.platform === "win32" ? "junction" : "dir");
  expect((await resolve()).identity.reason).toBe("blocked_record_root");
});

it("requires the exact ID, canonical project and pinned file identity", async () => {
  for (const meta of [{ id: "another-id", cwd: root }, { id: sessionId, cwd: "/" }]) {
    writeFileSync(sessionFile, JSON.stringify({ type: "session", ...meta }) + "\n"); expect((await resolve()).identity.reason).toBe("blocked_session_header");
  }
  record.file_identity = { dev: -1, ino: -1 }; save(); expect((await resolve()).identity.reason).toBe("blocked_session_replaced");
});

it.each([false, true])("rejects a same-header GJC inode replacement with a prior lookup=%s", async priorLookup => {
  const originalRecord = readFileSync(recordFile, "utf8");
  const originalFile = statSync(sessionFile);
  if (priorLookup) expect((await resolve()).identity.state).toBe("ready");
  const replacement = join(String(record.session_dir), "replacement.jsonl");
  writeFileSync(replacement, readFileSync(sessionFile), { mode: 0o600 });
  renameSync(replacement, sessionFile);
  expect(statSync(sessionFile).ino).not.toBe(originalFile.ino);
  expect(await resolve()).toMatchObject({ identity: { state: "blocked", reason: "blocked_session_replaced" }, sessionFile: null });
  const snapshot = { panes: [pane], agents: [pane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const projected = await labelManagedPanes(snapshot);
  expect(projected.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "blocked" } });
  expect(projected.agents[0]?.agent_session).toBeNull();
  await expect(conversationForPane(pane)).rejects.toThrow("blocked_session_replaced");
  expect(readFileSync(recordFile, "utf8")).toBe(originalRecord);
});

it.each([false, true])("denies a pinless GJC same-header replacement with a cached conversation=%s", async warm => {
  if (warm) expect((await conversationForPane(pane)).source).toBe("gjc-transcript");
  record.schema = 1; delete record.file_identity; save();
  const originalRecord = readFileSync(recordFile, "utf8");
  const originalFile = statSync(sessionFile);
  const replacement = join(String(record.session_dir), "replacement.jsonl");
  writeFileSync(replacement, [JSON.stringify({ type: "session", id: sessionId, cwd: root }), message("assistant", "unauthorized replacement")].join("\n") + "\n", { mode: 0o600 });
  renameSync(replacement, sessionFile);
  expect(statSync(sessionFile).ino).not.toBe(originalFile.ino);
  expect(await resolve()).toMatchObject({ identity: { harness: "gjc", state: "identity_pending", session_id: null }, sessionFile: null });
  const snapshot = { panes: [pane], agents: [pane], workspaces: [], tabs: [], layouts: [] } as unknown as SessionSnapshot;
  const projected = await labelManagedPanes(snapshot);
  expect(projected.panes[0]).toMatchObject({ agent: "gjc", agent_session: null, managed_session: { state: "identity_pending" } });
  expect(projected.agents[0]?.agent_session).toBeNull();
  await expect(resolveTranscript(pane, root)).rejects.toThrow("identity_pending");
  await expect(conversationForPane(pane)).rejects.toThrow("identity_pending");
  expect(readFileSync(recordFile, "utf8")).toBe(originalRecord);
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

  it("accepts a user-owned 0775 native store but never a world-writable one", async () => {
    sizedNativeHeader(harness, 1024);
    const store = harness === "codex" || harness === "claude" ? dirname(sessionFile) : String(record.session_dir);
    chmodSync(store, 0o775);
    expect((await resolve()).identity.state).toBe(harness === "codex" || harness === "claude" ? "ready" : "blocked");
    chmodSync(store, 0o777);
    expect((await resolve()).identity.state).toBe("blocked");
  });

  it("allows group-write only for a pinned OMO transcript", async () => {
    sizedNativeHeader(harness, 1024);
    chmodSync(sessionFile, 0o664);
    const result = await resolve();
    expect(result.identity.state).toBe(harness === "omo" ? "ready" : "blocked");
    expect(result.identity.reason).toBe(harness === "omo" ? null : "blocked_session_replaced");
  });
});

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
