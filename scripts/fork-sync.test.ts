import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "fork-sync.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  cmd(work, "git", "remote", "add", "origin", origin);
  cmd(work, "git", "remote", "add", "upstream", upstream);
  cmd(work, "git", "config", "commit.gpgsign", "false");
  cmd(work, "mkdir", "-p", "scripts");
  copyFileSync(source, join(work, "scripts/fork-sync.sh"));
  chmodSync(join(work, "scripts/fork-sync.sh"), 0o755);
  writeFileSync(join(work, "scripts/fork-sync-prompt.md"), "Sync {{TAG}} {{TREE}} {{MERGE}}\n");
  writeFileSync(join(work, "fixture.txt"), "base\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "base");
  cmd(work, "git", "push", "-u", "origin", "deploy/haemin");
  cmd(work, "git", "tag", "v0.4.1");
  cmd(work, "git", "push", "upstream", "v0.4.1");
  const state = join(home, "state", "herdr-web-ui-fork-sync");
  const run = (dry = false) => spawnSync("bash", [join(work, "scripts/fork-sync.sh"), ...(dry ? ["--dry-run"] : [])], {
    cwd: work, encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: join(home, "state"), HOME: home },
  });
  return { home, work, origin, upstream, state, run };
}
function advanceOrigin(work: string, origin: string) {
  const peer = join(resolve(work, ".."), "peer");
  cmd(resolve(work, ".."), "git", "clone", "-b", "deploy/haemin", origin, peer);
  cmd(peer, "git", "config", "user.name", "Fixture");
  cmd(peer, "git", "config", "user.email", "fixture@example.test");
  writeFileSync(join(peer, "advanced.txt"), "new\n");
  cmd(peer, "git", "add", ".");
  cmd(peer, "git", "commit", "-m", "advance");
  cmd(peer, "git", "push", "origin", "deploy/haemin");
  return cmd(peer, "git", "rev-parse", "HEAD");
}

test("dirty and non-deploy checkouts skip refresh and do not start a sync", () => {
  const { work, state, run } = fixture();
  writeFileSync(join(work, "dirty"), "user work");
  expect(run().stdout).toContain("refresh skipped");
  expect(existsSync(state)).toBe(false);
  rmSync(join(work, "dirty"));
  cmd(work, "git", "switch", "-c", "feature");
  expect(run().stdout).toContain("refresh skipped");
  expect(existsSync(state)).toBe(false);
});

test("clean deploy refresh fast-forwards before tag decisions", () => {
  const { work, origin, state, run } = fixture();
  const target = advanceOrigin(work, origin);
  const result = run();
  expect(result.status).toBe(0);
  expect(cmd(work, "git", "rev-parse", "HEAD")).toBe(target);
  expect(readFileSync(join(state, "v0.4.1"), "utf8")).toContain("contained");
});

test("divergent deploy branch refuses to run stale sync policy", () => {
  const { work, origin, state, run } = fixture();
  advanceOrigin(work, origin);
  writeFileSync(join(work, "local.txt"), "diverged\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "local divergence");
  const head = cmd(work, "git", "rev-parse", "HEAD");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("not a fast-forward");
  expect(cmd(work, "git", "rev-parse", "HEAD")).toBe(head);
  expect(existsSync(state)).toBe(false);
});

test("dry-run leaves checkout, refs, fetch metadata, state and worktrees untouched", () => {
  const { work, origin, state, run } = fixture();
  advanceOrigin(work, origin);
  const snapshot = () => [cmd(work, "git", "status", "--porcelain"), cmd(work, "git", "show-ref"),
    cmd(work, "git", "worktree", "list", "--porcelain"), cmd(work, "git", "rev-parse", "HEAD")];
  const before = snapshot();
  const fetchHead = join(work, ".git/FETCH_HEAD");
  const priorFetch = existsSync(fetchHead) ? readFileSync(fetchHead) : null;
  const result = run(true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("dry-run");
  expect(snapshot()).toEqual(before);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(fetchHead) ? readFileSync(fetchHead) : null).toEqual(priorFetch);
});

test("a new upstream tag starts an isolated merge and mocked Herdr agent", () => {
  const { home, work, upstream, state } = fixture();
  const upstreamWork = join(home, "upstream-work");
  cmd(home, "git", "clone", work, upstreamWork);
  cmd(upstreamWork, "git", "config", "user.name", "Fixture");
  cmd(upstreamWork, "git", "config", "user.email", "fixture@example.test");
  writeFileSync(join(upstreamWork, "upstream.txt"), "release\n");
  cmd(upstreamWork, "git", "add", ".");
  cmd(upstreamWork, "git", "commit", "-m", "upstream release");
  cmd(upstreamWork, "git", "tag", "v0.4.2");
  cmd(upstreamWork, "git", "push", upstream, "v0.4.2");
  const mock = join(home, "herdr");
  writeFileSync(mock, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${home}/herdr.calls'\ncase "$1" in workspace) printf '{"pane_id":"w1:p1"}\\n';; esac\n`);
  chmodSync(mock, 0o755);
  const result = spawnSync("bash", [join(work, "scripts/fork-sync.sh")], {
    cwd: work, encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: join(home, "state"), HOME: home, HERDR_BIN_PATH: mock },
  });
  expect(result.status).toBe(0);
  expect(existsSync(join(home, "sync-v0.4.2"))).toBe(true);
  expect(readFileSync(join(state, "v0.4.2"), "utf8")).toContain("merge clean");
  expect(readFileSync(join(home, "herdr.calls"), "utf8")).toContain("pane run w1:p1");
});
