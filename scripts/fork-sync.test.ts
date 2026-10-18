import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "fork-sync.sh");
const roots: string[] = [];
const childPids: number[] = [];
afterEach(() => {
  for (const root of roots) {
    const pidFile = join(root, "agent.pids");
    if (!existsSync(pidFile)) continue;
    for (const value of readFileSync(pidFile, "utf8").split("\n")) {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  for (const pid of childPids.splice(0)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cmd(cwd: string, program: string, ...args: string[]): string {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "fork-sync-"));
  roots.push(home);
  const work = join(home, "deploy");
  const origin = join(home, "origin.git");
  const upstream = join(home, "upstream.git");
  cmd(home, "git", "init", "--bare", origin);
  cmd(home, "git", "init", "--bare", upstream);
  cmd(home, "git", "init", "-b", "deploy/haemin", work);
  cmd(work, "git", "config", "user.name", "Fixture");
  cmd(work, "git", "config", "user.email", "fixture@example.test");
  cmd(work, "git", "config", "commit.gpgsign", "false");
  cmd(work, "git", "remote", "add", "origin", origin);
  cmd(work, "git", "remote", "add", "upstream", upstream);
  cmd(work, "mkdir", "-p", "scripts");
  copyFileSync(source, join(work, "scripts/fork-sync.sh"));
  chmodSync(join(work, "scripts/fork-sync.sh"), 0o755);
  writeFileSync(join(work, "scripts/fork-sync-prompt.md"), "Sync target=$FORK_SYNC_TARGET tree=$FORK_SYNC_WORKTREE\n");
  writeFileSync(join(work, "fixture.txt"), "base\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "base");
  cmd(work, "git", "push", "-u", "origin", "deploy/haemin");
  cmd(work, "git", "push", "upstream", "HEAD:refs/heads/main");

  const stateHome = join(home, "state");
  const state = join(stateHome, "herdr-web-ui-fork-sync");
  const mock = join(home, "herdr");
  const calls = join(home, "herdr.calls");
  const pids = join(home, "agent.pids");
  writeFileSync(mock, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = workspace ]; then printf '{"pane_id":"w1:p1"}\\n'; exit 0; fi
if [ "$1" = pane ] && [ "\${HERDR_MOCK_FAIL_LAUNCH:-0}" = 1 ]; then exit 23; fi
if [ "$1" = pane ] && [ "\${HERDR_MOCK_HOLD_AGENT:-0}" = 1 ]; then
  flock -n "$FORK_SYNC_AGENT_LOCK" -c 'sleep 10' >/dev/null 2>&1 &
  echo $! >> '${pids}'
fi
exit 0
`);
  chmodSync(mock, 0o755);
  const run = (options: { dry?: boolean; failLaunch?: boolean; holdAgent?: boolean; retryDelay?: number } = {}) => spawnSync("bash", [join(work, "scripts/fork-sync.sh"), ...(options.dry ? ["--dry-run"] : [])], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: stateHome,
      HERDR_BIN_PATH: mock,
      HERDR_MOCK_LOG: calls,
      HERDR_MOCK_PID_FILE: pids,
      ...(options.failLaunch ? { HERDR_MOCK_FAIL_LAUNCH: "1" } : {}),
      ...(options.holdAgent ? { HERDR_MOCK_HOLD_AGENT: "1" } : {}),
      ...(options.retryDelay === undefined ? {} : { HERDR_FORK_SYNC_RETRY_SECONDS: String(options.retryDelay) }),
    },
  });
  const statusFile = (target: string) => join(state, `main-${target}.status`);
  const launchCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("pane run ")).length : 0;
  const workspaceCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.startsWith("workspace create ")).length : 0;
  return { home, work, origin, upstream, state, mock, pids, run, statusFile, launchCalls, workspaceCalls };
}

function advanceUpstream(home: string, upstream: string) {
  const peer = join(home, "upstream-peer");
  cmd(home, "git", "clone", "--branch", "main", upstream, peer);
  cmd(peer, "git", "config", "user.name", "Fixture");
  cmd(peer, "git", "config", "user.email", "fixture@example.test");
  writeFileSync(join(peer, "upstream.txt"), "main changed without a tag\n");
  cmd(peer, "git", "add", ".");
  cmd(peer, "git", "commit", "-m", "advance upstream main");
  cmd(peer, "git", "push", "origin", "main");
  return cmd(peer, "git", "rev-parse", "HEAD");
}

function advanceOrigin(work: string, origin: string) {
  const peer = join(resolve(work, ".."), "deploy-peer");
  cmd(resolve(work, ".."), "git", "clone", "-b", "deploy/haemin", origin, peer);
  cmd(peer, "git", "config", "user.name", "Fixture");
  cmd(peer, "git", "config", "user.email", "fixture@example.test");
  writeFileSync(join(peer, "advanced.txt"), "origin moved\n");
  cmd(peer, "git", "add", ".");
  cmd(peer, "git", "commit", "-m", "advance deploy");
  cmd(peer, "git", "push", "origin", "deploy/haemin");
  return cmd(peer, "git", "rev-parse", "HEAD");
}

test("dry-run leaves checkout, refs, fetch metadata, state and worktrees untouched", () => {
  const { home, work, upstream, state, run } = fixture();
  advanceUpstream(home, upstream);
  const snapshot = () => [cmd(work, "git", "status", "--porcelain"), cmd(work, "git", "show-ref"),
    cmd(work, "git", "worktree", "list", "--porcelain"), cmd(work, "git", "rev-parse", "HEAD")];
  const before = snapshot();
  const fetchHead = join(work, ".git/FETCH_HEAD");
  const priorFetch = existsSync(fetchHead) ? readFileSync(fetchHead) : null;
  const result = run({ dry: true });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("would be checked");
  expect(snapshot()).toEqual(before);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(fetchHead) ? readFileSync(fetchHead) : null).toEqual(priorFetch);
});

test("a status marker does not skip a target absent from the deploy and candidate commits", () => {
  const { home, work, upstream, state, run, statusFile, launchCalls } = fixture();
  const target = advanceUpstream(home, upstream);
  mkdirSync(state, { recursive: true });
  writeFileSync(statusFile(target), `state=validated\ntarget=${target}\nattempt=1\nupdated_epoch=0\n`);
  const result = run({ holdAgent: true, retryDelay: 0 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("lacks actual target containment");
  expect(launchCalls()).toBe(1);
  expect(readFileSync(statusFile(target), "utf8")).toContain("state=started");
  expect(spawnSync("git", ["merge-base", "--is-ancestor", target, "HEAD"], { cwd: work }).status).toBe(1);
});

test("a stale started attempt resumes on its deterministic worktree", () => {
  const { home, upstream, state, run, statusFile, launchCalls, workspaceCalls } = fixture();
  const target = advanceUpstream(home, upstream);
  mkdirSync(state, { recursive: true });
  writeFileSync(statusFile(target), `state=started\ntarget=${target}\nattempt=1\nupdated_epoch=0\npane=\n`);
  const result = run({ holdAgent: true, retryDelay: 0 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("previous attempt is stale");
  expect(readFileSync(statusFile(target), "utf8")).toContain("attempt=2");
  expect(workspaceCalls()).toBe(1);
  expect(launchCalls()).toBe(1);
  expect(existsSync(join(home, `sync-upstream-main-${target.slice(0, 12)}`))).toBe(true);
});

test("failed agent launch is visible and retries in the same worktree without another workspace", () => {
  const { home, upstream, run, statusFile, workspaceCalls, launchCalls } = fixture();
  const target = advanceUpstream(home, upstream);
  const first = run({ failLaunch: true, retryDelay: 0 });
  expect(first.status).toBe(1);
  expect(first.stdout).toContain("agent launch failed");
  expect(readFileSync(statusFile(target), "utf8")).toContain("state=failed");
  const tree = join(home, `sync-upstream-main-${target.slice(0, 12)}`);
  expect(existsSync(tree)).toBe(true);
  const second = run({ retryDelay: 0 });
  expect(second.status).toBe(0);
  expect(readFileSync(statusFile(target), "utf8")).toContain("attempt=2");
  expect(readFileSync(statusFile(target), "utf8")).toContain("state=started");
  expect(workspaceCalls()).toBe(1);
  expect(launchCalls()).toBe(2);
});

test("repeated polling does not launch a second agent while the first target lock is held", () => {
  const { home, upstream, run, workspaceCalls, launchCalls } = fixture();
  advanceUpstream(home, upstream);
  const first = run({ holdAgent: true, retryDelay: 0 });
  expect(first.status).toBe(0);
  expect(launchCalls()).toBe(1);
  const second = run({ holdAgent: true, retryDelay: 0 });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("already running");
  expect(launchCalls()).toBe(1);
  expect(workspaceCalls()).toBe(1);
});

test("records actual deploy containment without starting an agent", () => {
  const { work, state, run, statusFile } = fixture();
  const target = cmd(work, "git", "rev-parse", "HEAD");
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("is contained");
  expect(readFileSync(statusFile(target), "utf8")).toContain("state=contained");
  expect(existsSync(join(state, `main-${target}.agent.lock`))).toBe(false);
});

test("detects upstream main changes without waiting for a new release tag", () => {
  const { home, work, upstream, run, statusFile, launchCalls } = fixture();
  const beforeTags = cmd(work, "git", "tag", "--list", "v*");
  const target = advanceUpstream(home, upstream);
  const afterTags = cmd(work, "git", "tag", "--list", "v*");
  expect(afterTags).toBe(beforeTags);
  const result = run({ holdAgent: true, retryDelay: 0 });
  expect(result.status).toBe(0);
  expect(launchCalls()).toBe(1);
  expect(readFileSync(statusFile(target), "utf8")).toContain("target=" + target);
});

test("dirty and non-deploy checkouts do not refresh or start a sync", () => {
  const { work, state, run } = fixture();
  writeFileSync(join(work, "dirty"), "user work");
  expect(run().stdout).toContain("refresh skipped");
  expect(existsSync(state)).toBe(false);
  rmSync(join(work, "dirty"));
  cmd(work, "git", "switch", "-c", "feature");
  expect(run().stdout).toContain("refresh skipped");
  expect(existsSync(state)).toBe(false);
});

test("a divergent deploy branch refuses stale sync policy", () => {
  const { work, origin, state, run } = fixture();
  advanceOrigin(work, origin);
  writeFileSync(join(work, "local.txt"), "local divergence\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "local divergence");
  const head = cmd(work, "git", "rev-parse", "HEAD");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("not a fast-forward");
  expect(cmd(work, "git", "rev-parse", "HEAD")).toBe(head);
  expect(readdirSync(state).filter((name) => name.endsWith(".status"))).toEqual([]);
});
