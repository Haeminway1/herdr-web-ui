import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";
import {
  isGitOutsideWorktree,
  gjcSdkCurrentSessionWithRunner as sdkCurrentSessionWithRunner,
  gjcSdkTranscriptWithRunner as sdkTranscriptWithRunner,
  type GjcSdkCommandOptions,
  type GjcSdkCommandRunner,
  type GjcSdkWorktreeRootResolver,
} from "./gjc-sdk.ts";

const cwd = mkdtempSync(join(tmpdir(), "gjc-sdk-test-"));
const agentDir = join(cwd, "agent");
const savedPath = join(cwd, "sessions", "session.jsonl");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const locator = () => ({ cwd, worktreeRoot: cwd, stateRoot: join(cwd, ".gjc", "state") });

const testWorktreeRootResolver: GjcSdkWorktreeRootResolver = async () => cwd;
const currentGeneration = async () => true;

function gjcSdkTranscriptWithRunner(
  pids: readonly number[],
  workingDirectory: string,
  directory: string,
  runner: GjcSdkCommandRunner,
  rootResolver: GjcSdkWorktreeRootResolver = testWorktreeRootResolver,
  cacheClock?: () => number,
  generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => true,
) {
  return sdkTranscriptWithRunner(pids, workingDirectory, directory, runner, rootResolver, cacheClock, generationCurrent);
}

function gjcSdkCurrentSessionWithRunner(
  pids: readonly number[],
  workingDirectory: string,
  directory: string,
  runner: GjcSdkCommandRunner,
  rootResolver: GjcSdkWorktreeRootResolver = testWorktreeRootResolver,
  cacheClock?: () => number,
  generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => true,
) {
  return sdkCurrentSessionWithRunner(pids, workingDirectory, directory, runner, rootResolver, cacheClock, generationCurrent);
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    locator: locator(),
    endpointGeneration: 4,
    pid: 321,
    hostIncarnation: "linux:12345",
    identityProvenance: "composite",
    terminalUncertain: false,
    ambiguous: false,
    terminal: false,
    live: true,
    ...overrides,
  };
}

function broker(result: Record<string, unknown>): string {
  return JSON.stringify({ type: "broker_response", ok: true, result });
}

function page(sessions: unknown[], extra: Record<string, unknown> = {}): string {
  return broker({ indexSeq: 11, sessions, ...extra });
}

function scope(cwd: string, worktreeRoot: string | null = cwd) {
  return { version: 1, requested: "pwd", requestAnchor: { cwd, worktreeRoot } };
}

function saved(row: Record<string, unknown> = session(), id = "session-1", path = savedPath): string {
  return page([row], { savedSession: { id, path } });
}

interface Call {
  command: string;
  args: string[];
  options: GjcSdkCommandOptions;
}

function fakeRunner(
  output: readonly string[] | ((args: string[], call: number) => string | Promise<string>),
): { calls: Call[]; runner: GjcSdkCommandRunner } {
  const calls: Call[] = [];
  const runner: GjcSdkCommandRunner = async (command, args, options) => {
    const call = calls.length;
    calls.push({ command, args: [...args], options });
    if (typeof output === "function") return output(args, call);
    const response = output[call];
    if (response === undefined) throw new Error("Unexpected SDK command");
    return response;
  };
  return { calls, runner };
}

const commandArgs = [
  "sdk", "session", "raw", "global",
  "--op", "session.list",
  "--page", "--limit", "100",
  "--agent-dir", agentDir,
  "--attach-only", "--json",
];

describe("GJC live identity independent of saved-store indexing", () => {
  it("accepts a null Git anchor only for the exact non-worktree diagnostic", async () => {
    const outside = { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n" };
    expect(isGitOutsideWorktree(outside)).toBe(true);
    for (const failure of [
      { ...outside, stderr: "fatal: detected dubious ownership in repository at '/private/work'\n" },
      { ...outside, stderr: "fatal: cannot open .git/config: Permission denied\n" },
      { ...outside, stderr: "Permission denied\n" + outside.stderr },
      { ...outside, stdout: "unexpected" },
      { ...outside, code: "EACCES" },
    ]) expect(isGitOutsideWorktree(failure)).toBe(false);
    const row = session({ locator: { ...locator(), worktreeRoot: null } });
    const fixture = fakeRunner([page([row]), saved(row)]);
    await expect(sdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, undefined, undefined, currentGeneration))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(2);
  });

  it("rejects stale generation even when both cached broker pages still report the old index", async () => {
    const fixture = fakeRunner([page([session()]), saved()]);
    let current = true;
    const generation = async () => current;
    const lookup = () => sdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generation);
    expect((await lookup())?.sessionId).toBe("session-1");
    current = false;
    expect(await lookup()).toBeNull();
    expect(await sdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generation)).toBeNull();
    expect(fixture.calls).toHaveLength(2);
  });

  it.each(["ENOENT", "EACCES", "ETIMEDOUT"])("rejects %s without leaking CLI details or erasing a pending identity", async (code) => {
    const runner: GjcSdkCommandRunner = async () => { throw Object.assign(new Error("secret /home/user/private"), { code }); };
    for (const lookup of [gjcSdkCurrentSessionWithRunner, gjcSdkTranscriptWithRunner]) {
      const failure = lookup([321], cwd, agentDir, runner);
      await expect(failure).rejects.toBeInstanceOf(GjcSdkLookupError);
      await expect(failure).rejects.toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable" });
      await expect(failure).rejects.not.toThrow("secret");
    }
  });
  it("checks generation for a current identity without a saved transcript", async () => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    const observed: string[] = [];
    const generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async (directory, id, generation) => {
      observed.push(`${directory}:${id}:${generation}`);
      return observed.length === 1;
    };
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toBeNull();
    expect(observed).toEqual([`${agentDir}:session-1:4`, `${agentDir}:session-1:4`]);
    expect(fixture.calls).toHaveLength(2);
  });
  it("proves the current private session even when the saved-store index has no path", async () => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    expect(await gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver))
      .toEqual({ sessionId: "session-1", pid: 321, hostIncarnation: "linux:12345", endpointGeneration: 4 });
    const transcript = fakeRunner([page([session()]), page([session()], { savedSession: null })]);
    expect(await gjcSdkTranscriptWithRunner([321], cwd, agentDir, transcript.runner)).toBeNull();
  });

  it.each([
    null,
    { id: "session-1" },
    { id: "session-1", path: "relative.jsonl" },
    { id: "another-session", path: savedPath },
  ])("keeps live authority separate from unreadable saved metadata %j", async (savedSession) => {
    const fixture = fakeRunner([page([session()]), page([session()], { savedSession })]);
    const generations: [string, number][] = [];
    const generationCurrent = async (_directory: string, id: string, generation: number) => {
      generations.push([id, generation]);
      return true;
    };
    await expect(sdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1", pid: 321 });
    await expect(sdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent)).resolves.toBeNull();
    expect(generations).toEqual([["session-1", 4], ["session-1", 4]]);
    expect(fixture.calls).toHaveLength(2);
  });

  it("does not relax ambiguous, uncertain or changed live authority for private sessions", async () => {
    for (const invalid of [{ ambiguous: true }, { terminalUncertain: true }, { live: false }, { endpointGeneration: 5 }, { hostIncarnation: "linux:other" }]) {
      const fixture = fakeRunner([page([session()]), page([session(invalid)], { savedSession: null })]);
      expect(await gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver)).toBeNull();
    }
  });
});

describe("GJC SDK transcript identity binding", () => {
  it("ignores only the proven generation-zero direct-session GC fence after /new", async () => {
    mkdirSync(agentDir, { recursive: true });
    const fence = session({
      sessionId: "previous-session",
      endpointGeneration: 0,
      processIncarnation: "linux:12345",
      locator: { ...locator(), stateRoot: agentDir },
    });
    const valid = fakeRunner([page([fence, session()]), saved()]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, valid.runner))
      .resolves.toMatchObject({ sessionId: "session-1" });
    for (const invalid of [
      { ...fence, locator: { ...locator(), stateRoot: cwd } },
      { ...fence, terminalUncertain: true },
      { ...fence, ambiguous: true },
      { ...fence, processIncarnation: "linux:other" },
      { ...fence, endpointFileId: "unexpected-endpoint" },
    ]) {
      const { runner } = fakeRunner([page([invalid, session()]), saved()]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("uses a null SDK worktree anchor for a directory outside Git", async () => {
    const row = session({ locator: { ...locator(), worktreeRoot: null } });
    const { calls, runner } = fakeRunner([page([row]), saved(row)]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, async () => null))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd, null) })]);
  });

  it("resolves the matching process identity and the SDK's saved file", async () => {
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toEqual({
      sessionId: "session-1",
      pid: 321,
      path: savedPath,
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
      guardSessionIds: ["session-1"],
    });
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]],
      ["gjc", [...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]],
    ]);
  });

  it("paginates with the same limit and rejects conflicting page index sequences", async () => {
    const { calls, runner } = fakeRunner([
      page([session({ pid: 999 })], { continuationCursor: "next-page" }),
      page([session()]),
      saved(),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd), cursor: "next-page" })]);
    expect(calls[2]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd, resolveSessionId: "session-1" })]);

    const conflicting = fakeRunner([
      page([], { continuationCursor: "next-page" }),
      broker({ indexSeq: 12, sessions: [session()] }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflicting.runner)).resolves.toBeNull();
    expect(conflicting.calls).toHaveLength(2);
  });

  it("guards stale and direct-fence same-pid sessions across pages without unrelated pids", async () => {
    mkdirSync(agentDir, { recursive: true });
    const stale = session({ sessionId: "stale-same-pid", live: false });
    const fence = session({
      sessionId: "direct-fence",
      endpointGeneration: 0,
      processIncarnation: "linux:12345",
      locator: { ...locator(), stateRoot: agentDir },
    });
    const unrelated = session({ sessionId: "unrelated-pid", pid: 999 });
    const exactStale = session({ sessionId: "exact-stale-same-pid", deleted: true });
    const exactUnrelated = session({ sessionId: "exact-unrelated-pid", pid: 999 });
    const { runner } = fakeRunner([
      page([stale, unrelated], { continuationCursor: "next-page" }),
      page([fence, session()]),
      page([stale, fence, session(), exactStale, exactUnrelated], {
        savedSession: { id: "session-1", path: savedPath },
      }),
    ]);

    const binding = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    expect(binding?.guardSessionIds).toEqual([
      "stale-same-pid",
      "direct-fence",
      "session-1",
      "exact-stale-same-pid",
    ]);
    expect(binding?.guardSessionIds).not.toContain("unrelated-pid");
    expect(binding?.guardSessionIds).not.toContain("exact-unrelated-pid");
  });

  it("does not choose by cwd alone when multiple pane GJC processes match", async () => {
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2", pid: 322 })])]);
    await expect(gjcSdkTranscriptWithRunner([321, 322], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("scopes the scan so unrelated historical sessions beyond the page budget are excluded", async () => {
    const historical = Array.from({ length: 801 }, (_, index) => session({
      sessionId: `historical-${index}`,
      pid: 10_000 + index,
      live: false,
      locator: { cwd: join(cwd, `history-${index}`), worktreeRoot: null, stateRoot: join(cwd, ".gjc", "state") },
    }));
    const calls: Call[] = [];
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      const inputIndex = args.indexOf("--json-input");
      const input = inputIndex >= 0 ? JSON.parse(args[inputIndex + 1]!) : {};
      if (call === 0) {
        const rows = [...historical, session()].filter((row) => row.locator && (row.locator as Record<string, unknown>).cwd === input.scope?.requestAnchor.cwd);
        return page(rows);
      }
      return saved();
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls).toHaveLength(2);
  });

  it("accepts a live session alongside definitively retired rows for the same pid", async () => {
    const terminal = session({ sessionId: "old-session", terminal: true, terminalUncertain: false });
    const deleted = session({ sessionId: "deleted-session", deleted: true });
    const { calls, runner } = fakeRunner([
      page([terminal, deleted, session()]),
      page([terminal, deleted, session()], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(2);
  });

  it("rejects competing active rows after exact lookup even when discovery was unique", async () => {
    const current = session();
    const competing = session({ sessionId: "session-2" });
    const { calls, runner } = fakeRunner([
      page([current]),
      page([current, competing], { savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("uses the row's original symlinked cwd for exact resolution and matches its canonical identity", async () => {
    const alias = join(cwd, "cwd-alias");
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const discoveryRow = session({ locator: { ...locator(), cwd: alias } });
    const { calls, runner } = fakeRunner([page([discoveryRow]), saved()]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls[0]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(calls[1]!.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ cwd: alias, resolveSessionId: "session-1" })]);
  });

  it("anchors a pwd scope at its containing git worktree root", async () => {
    const nestedCwd = join(cwd, "nested");
    const worktreeAlias = join(cwd, "worktree-alias");
    mkdirSync(nestedCwd);
    symlinkSync(cwd, worktreeAlias, process.platform === "win32" ? "junction" : "dir");
    const row = session({ locator: { ...locator(), cwd: nestedCwd } });
    let receivedCwd = "";
    let receivedTimeout = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async (requestedCwd, timeoutMs) => {
      receivedCwd = requestedCwd;
      receivedTimeout = timeoutMs;
      return worktreeAlias;
    };
    const { calls, runner } = fakeRunner([
      page([row]),
      page([row], { savedSession: { id: "session-1", path: savedPath } }),
    ]);

    await expect(gjcSdkTranscriptWithRunner([321], nestedCwd, agentDir, runner, rootResolver)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(receivedCwd).toBe(nestedCwd);
    expect(receivedTimeout).toBeGreaterThan(0);
    expect(receivedTimeout).toBeLessThanOrEqual(2_000);
    expect(calls[0]!.args).toEqual([
      ...commandArgs,
      "--json-input",
      JSON.stringify({ scope: scope(nestedCwd, cwd) }),
    ]);
  });

  it.each(["ENOENT", "EACCES", "ETIMEDOUT"])("sanitizes %s worktree resolver failures before starting the broker", async (code) => {
    let rootLookups = 0;
    const secret = `private ${code} worktree credentials`;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      throw Object.assign(new Error(secret), { code });
    };
    const { calls, runner } = fakeRunner([page([session()]), saved()]);

    const failure = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver).catch(error => error);
    expect(failure).toBeInstanceOf(GjcSdkLookupError);
    expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(rootLookups).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("distinguishes two same-cwd panes by each pane's supplied GJC pid", async () => {
    const rows = [session(), session({ sessionId: "session-2", pid: 322 })];
    const { runner } = fakeRunner((args) => {
      const inputIndex = args.indexOf("--json-input");
      const rawInput = args[inputIndex + 1];
      if (rawInput === undefined) throw new Error("Missing SDK query input");
      const input: unknown = JSON.parse(rawInput);
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid SDK query input");
      if (!("resolveSessionId" in input)) return page(rows);
      const sessionId = input.resolveSessionId;
      if (typeof sessionId !== "string") throw new Error("Invalid exact session id");
      const row = rows.find((candidate) => candidate.sessionId === sessionId);
      if (row === undefined) throw new Error("Unknown exact session id");
      return saved(row, sessionId, join(cwd, `${sessionId}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner);
    const second = await gjcSdkTranscriptWithRunner([322], cwd, agentDir, runner);
    expect(first?.sessionId).toBe("session-1");
    expect(second?.sessionId).toBe("session-2");
  });

  it("fails closed for multiple live rows competing for one pane process", async () => {
    const { calls, runner } = fakeRunner([page([session(), session({ sessionId: "session-2" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(1);

    const malformed = fakeRunner([page([session(), session({ identityProvenance: "legacy" })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).resolves.toBeNull();
    expect(malformed.calls).toHaveLength(1);

    const conflictingCwd = fakeRunner([page([session(), session({ locator: { ...locator(), cwd: join(cwd, "other") } })])]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, conflictingCwd.runner)).resolves.toBeNull();
    expect(conflictingCwd.calls).toHaveLength(1);
  });

  it("observes a /new session after the raw listing cache expires", async () => {
    let now = 0;
    const cacheClock = () => now;
    const { calls, runner } = fakeRunner((_args, call) => {
      const turn = Math.floor(call / 2);
      const row = session({ sessionId: `session-${turn + 1}` });
      return call % 2 === 0 ? page([row]) : saved(row, `session-${turn + 1}`, join(cwd, `session-${turn + 1}.jsonl`));
    });

    const first = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock);
    now = 10_000;
    const second = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock);
    expect(first?.sessionId).toBe("session-1");
    expect(second).toEqual({
      sessionId: "session-2",
      pid: 321,
      path: join(cwd, "session-2.jsonl"),
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
      guardSessionIds: ["session-2"],
    });
    expect(calls).toHaveLength(4);
  });

  it("ignores stale, deleted, terminal, legacy, uncertain, and unrelated rows", async () => {
    const invalidRows: Record<string, unknown>[] = [
      { live: false },
      { deleted: true },
      { terminal: true },
      { terminalUncertain: true },
      { ambiguous: true },
      { identityProvenance: "legacy" },
      { endpointGeneration: 0 },
      { hostIncarnation: " " },
      { pid: 999 },
      { locator: { ...locator(), cwd: join(cwd, "other") } },
    ];
    for (const invalid of invalidRows) {
      const { calls, runner } = fakeRunner([page([session(invalid)])]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it("rechecks the full locator, generation, and host incarnation before returning a path", async () => {
    const changedRows = [
      session({ endpointGeneration: 5 }),
      session({ hostIncarnation: "linux:next" }),
      session({ locator: { ...locator(), stateRoot: join(cwd, "other-state") } }),
    ];
    for (const changed of changedRows) {
      const { calls, runner } = fakeRunner([page([session()]), saved(changed)]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
      expect(calls).toHaveLength(2);
    }
  });

  it("rejects an exact lookup from an older broker index sequence", async () => {
    const older = broker({ indexSeq: 10, sessions: [session()], savedSession: { id: "session-1", path: savedPath } });
    const { calls, runner } = fakeRunner([page([session()]), older]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("requires the exact saved session and an absolute path", async () => {
    const invalidSavedSessions = [
      undefined,
      { id: "another-session", path: savedPath },
      { id: "session-1", path: "relative/session.jsonl" },
    ];
    for (const savedSession of invalidSavedSessions) {
      const result = page([session()], savedSession === undefined ? {} : { savedSession });
      const { runner } = fakeRunner([page([session()]), result]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }
  });

  it("refuses an incomplete exact lookup rather than accepting its saved path", async () => {
    const { runner } = fakeRunner([
      page([session()]),
      page([session()], { continuationCursor: "incomplete", savedSession: { id: "session-1", path: savedPath } }),
    ]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
  });

  it("ends a hung SDK lookup at its deadline", async () => {
    let calls = 0;
    const runner: GjcSdkCommandRunner = () => {
      calls += 1;
      return new Promise(() => {});
    };
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout", message: "GJC SDK lookup failed" });
    expect(calls).toBe(1);
  });

  it("rejects malformed broker output and repeated or over-budget pagination", async () => {
    for (const output of ["not json", broker({ indexSeq: 1, sessions: {} })]) {
      const { runner } = fakeRunner([output]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).resolves.toBeNull();
    }

    const secret = "private broker credentials";
    for (const code of ["ENOENT", "EACCES"]) {
      const output = JSON.stringify({ type: "broker_response", ok: false, error: { code, message: secret } });
      const { calls, runner } = fakeRunner([output]);
      const failure = await gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(calls).toHaveLength(1);
    }

    const repeated = fakeRunner([page([], { continuationCursor: "same" }), page([], { continuationCursor: "same" })]);
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, repeated.runner)).resolves.toBeNull();
    expect(repeated.calls).toHaveLength(2);

    for (const cursor of ["", "  ", 7, { token: "cursor" }]) {
      const malformed = fakeRunner([page([], { continuationCursor: cursor })]);
      await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, malformed.runner)).resolves.toBeNull();
      expect(malformed.calls).toHaveLength(1);
    }

    const pages = fakeRunner((_args, call) => page([], { continuationCursor: `cursor-${call}` }));
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, pages.runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    expect(pages.calls).toHaveLength(6); // the global spawn budget precedes the larger page ceiling
  });

  it.each(["discovery", "exact"] as const)("reports %s broker failures as sanitized unavailable and never caches them", async phase => {
    const failure = JSON.stringify({ type: "broker_response", ok: false, error: "secret /private/session" });
    const fixture = fakeRunner((_args, call) => phase === "discovery" || call > 0 ? failure : page([session()]));
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    expect(fixture.calls).toHaveLength(phase === "discovery" ? 2 : 3);
  });

  it("keeps SDK execution bounded, non-interactive, and quiet on transport failure", async () => {
    let captured: Call | undefined;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      captured = { command, args: [...args], options };
      throw new Error("broker credentials and local paths must not escape");
    };

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed" });
    expect(captured?.command).toBe("gjc");
    expect(captured?.args).toEqual([...commandArgs, "--json-input", JSON.stringify({ scope: scope(cwd) })]);
    expect(captured?.options.env.GJC_SDK_BROKER_AUTOSTART).toBe("0");
    expect(captured?.options.shell).toBe(false);
    expect(captured?.options).not.toHaveProperty("stdio");
    expect(captured?.options.maxBuffer).toBe(1024 * 1024);
    expect(captured?.options.timeout).toBeGreaterThan(0);
    expect(captured?.options.timeout).toBeLessThanOrEqual(2_000);
    expect(captured?.options.killSignal).toBe("SIGKILL");
  });
});

describe("GJC SDK session.list cache", () => {
  it("rejects a revoked generation on each cached transcript read without starting another runner", async () => {
    const fixture = fakeRunner([page([session()]), saved()]);
    let observations = 0;
    const generationCurrent: typeof import("./gjc-sdk-generation.ts").gjcSdkGenerationCurrent = async () => ++observations === 1;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toMatchObject({ sessionId: "session-1", guardSessionIds: ["session-1"] });
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner, testWorktreeRootResolver, undefined, generationCurrent))
      .resolves.toBeNull();
    expect(observations).toBe(2);
    expect(fixture.calls).toHaveLength(2);
  });

  it.each(["ENOENT", "EACCES", "BROKER"] as const)("sanitizes %s failures on both lookup paths and retries failed raw queries", async code => {
    const secret = `private ${code} credentials ${savedPath}`;
    for (const lookup of [gjcSdkTranscriptWithRunner, gjcSdkCurrentSessionWithRunner]) {
      const fixture = fakeRunner((_args, call) => {
        if (call === 0) throw Object.assign(new Error(secret), { code });
        return call === 1 ? page([session()]) : saved();
      });
      const failure = await lookup([321], cwd, agentDir, fixture.runner).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(secret);
      await expect(lookup([321], cwd, agentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
      expect(fixture.calls).toHaveLength(3);
    }
  });
  it("coalesces concurrent callers for the same raw query", async () => {
    let resolveFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveSecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      resolveSecondRoot = resolve;
    });
    let rootLookups = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      if (rootLookups === 2) resolveSecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      if (call === 0) {
        resolveFirstStarted();
        await firstGate;
      }
      return call % 2 === 0 ? page([session()]) : saved();
    };

    const first = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver);
    await firstStarted;
    const second = gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, rootResolver);
    await secondRootStarted;
    await nextTurn();
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "session-1", pid: 321, path: savedPath, hostIncarnation: "linux:12345", endpointGeneration: 4, guardSessionIds: ["session-1"] },
      { sessionId: "session-1", pid: 321, path: savedPath, hostIncarnation: "linux:12345", endpointGeneration: 4, guardSessionIds: ["session-1"] },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("hits the TTL cache and starts new listings at expiry", async () => {
    let now = 0;
    const cacheClock = () => now;
    const { calls, runner } = fakeRunner((_args, call) => call % 2 === 0 ? page([session()]) : saved());

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    now = 9_999;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(2);

    now = 10_000;
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, runner, testWorktreeRootResolver, cacheClock))
      .resolves.toMatchObject({ sessionId: "session-1" });
    expect(calls).toHaveLength(4);
  });

  it("retries failed and malformed listings without caching them", async () => {
    for (const firstResult of ["malformed", "failed"] as const) {
      const fixture = fakeRunner((_args, call) => {
        if (call === 0 && firstResult === "malformed") return "not json";
        if (call === 0) throw new Error("fixture transport failure");
        return page([session()]);
      });

      if (firstResult === "failed") {
        await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable" });
      } else {
        await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
      }
      await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toEqual({
        sessionId: "session-1",
        pid: 321,
        hostIncarnation: "linux:12345",
        endpointGeneration: 4,
      });
      expect(fixture.calls).toHaveLength(3);
    }
  });

  it("keeps identity rejection when raw discovery and exact rows are cached", async () => {
    const changedIdentity = session({ endpointGeneration: 5 });
    const fixture = fakeRunner([page([session()]), saved(changedIdentity)]);

    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
    await expect(gjcSdkTranscriptWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toBeNull();
    expect(fixture.calls).toHaveLength(2);
  });

  it("separates listings by agentDir", async () => {
    const secondAgentDir = join(cwd, "second-agent");
    const fixture = fakeRunner((_args, _call) => page([session()]));

    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, secondAgentDir, fixture.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(4);
    expect(fixture.calls[0]?.args).toContain(agentDir);
    expect(fixture.calls[2]?.args).toContain(secondAgentDir);
  });

  it("isolates fixture caches by command runner", async () => {
    const firstRunner = fakeRunner((_args, _call) => page([session()]));
    const secondRunner = fakeRunner((_args, _call) => page([session({ sessionId: "session-2" })]));

    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, firstRunner.runner)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, secondRunner.runner)).resolves.toMatchObject({ sessionId: "session-2" });
    expect(firstRunner.calls).toHaveLength(2);
    expect(secondRunner.calls).toHaveLength(2);
  });

  it("bounds starts across agent roots, fails closed at the deadline, and recovers at the next window", async () => {
    let now = 0;
    const clock = () => now;
    const fixture = fakeRunner(() => page([session()]));
    const lookup = (root: number) => gjcSdkCurrentSessionWithRunner([321], cwd, join(cwd, `budget-agent-${root}`), fixture.runner, testWorktreeRootResolver, clock);
    for (const root of [1, 2, 3]) await expect(lookup(root)).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(lookup(4)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    await expect(lookup(4)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });
    expect(fixture.calls).toHaveLength(6);
    now = 10_050;
    await expect(lookup(4)).resolves.toMatchObject({ sessionId: "session-1" });
    expect(fixture.calls).toHaveLength(8);
  });

  it.each(["same", "different"])("serializes raw queries with %s agent directories", async (directory) => {
    const nestedCwd = join(cwd, "nested-query");
    mkdirSync(nestedCwd, { recursive: true });
    const nestedSession = session({
      sessionId: "session-2",
      pid: 322,
      locator: { ...locator(), cwd: nestedCwd },
    });
    let resolveFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveSecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      resolveSecondRoot = resolve;
    });
    let rootLookups = 0;
    const rootResolver: GjcSdkWorktreeRootResolver = async () => {
      rootLookups += 1;
      if (rootLookups === 2) resolveSecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (call === 0) {
        resolveFirstStarted();
        await firstGate;
      }
      active -= 1;
      return page([session(), nestedSession]);
    };

    const first = gjcSdkCurrentSessionWithRunner([321], cwd, agentDir, runner, rootResolver);
    await firstStarted;
    const second = gjcSdkCurrentSessionWithRunner([322], nestedCwd, directory === "same" ? agentDir : join(cwd, "other-agent"), runner, rootResolver);
    await secondRootStarted;
    await nextTurn();
    const callsWhileFirstIsActive = calls.length;
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "session-1", pid: 321, hostIncarnation: "linux:12345", endpointGeneration: 4 },
      { sessionId: "session-2", pid: 322, hostIncarnation: "linux:12345", endpointGeneration: 4 },
    ]);
    expect(callsWhileFirstIsActive).toBe(1);
    expect(calls).toHaveLength(4);
    expect(maxActive).toBe(1);
  });
});


describe("GJC SDK session.list timeout queue", () => {
  it("keeps the queue until a timed-out runner actually settles", async () => {
    const nestedCwd = join(cwd, "timeout-nested");
    mkdirSync(nestedCwd, { recursive: true });
    const nestedSession = session({
      sessionId: "session-2",
      pid: 322,
      locator: { ...locator(), cwd: nestedCwd },
    });
    let notifyFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });
    let releaseFirstRunner: () => void = () => {};
    const firstRunnerGate = new Promise<void>((resolve) => {
      releaseFirstRunner = resolve;
    });
    let notifySecondRoot: () => void = () => {};
    const secondRootStarted = new Promise<void>((resolve) => {
      notifySecondRoot = resolve;
    });
    const rootResolver: GjcSdkWorktreeRootResolver = async (requestedCwd) => {
      if (requestedCwd === nestedCwd) notifySecondRoot();
      return cwd;
    };
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: GjcSdkCommandRunner = async (command, args, options) => {
      const call = calls.length;
      calls.push({ command, args: [...args], options });
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (call === 0) {
        notifyFirstStarted();
        await firstRunnerGate;
        active -= 1;
        return page([session()]);
      }
      active -= 1;
      const inputIndex = args.indexOf("--json-input");
      const rawInput = args[inputIndex + 1];
      if (rawInput === undefined) throw new Error("Missing SDK query input");
      const input: unknown = JSON.parse(rawInput);
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid SDK query input");
      if ("resolveSessionId" in input) return page([nestedSession], { savedSession: null });
      return page([session(), nestedSession]);
    };

    const first = sdkCurrentSessionWithRunner([321], cwd, agentDir, runner, rootResolver, undefined, async () => true);
    await firstStarted;
    await expect(first).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "timeout" });

    const second = sdkCurrentSessionWithRunner([322], nestedCwd, agentDir, runner, rootResolver, undefined, currentGeneration);
    await secondRootStarted;
    await nextTurn();
    expect(calls).toHaveLength(1);

    releaseFirstRunner();
    await expect(second).resolves.toEqual({
      sessionId: "session-2",
      pid: 322,
      hostIncarnation: "linux:12345",
      endpointGeneration: 4,
    });
    expect(calls).toHaveLength(3);
    expect(maxActive).toBe(1);
  });
});
