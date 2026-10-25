import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const releaseSource = resolve(import.meta.dir, "fork-release.sh");
const validatorSource = resolve(import.meta.dir, "full-validation-report.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cmd(cwd: string, program: string, ...args: string[]): string {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

function field(file: string, key: string): string {
  if (!existsSync(file)) return "";
  const prefix = `${key}=`;
  return readFileSync(file, "utf8").split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function refSha(origin: string, ref: string): string {
  const result = spawnSync("git", ["--git-dir", origin, "rev-parse", "--verify", ref], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

type BunMode = "success" | "missing-report" | "malformed-report" | "failed-report" | "skipped-step" | "missing-step" | "wrong-sha" | "dirty" | "head-changed";

interface RunOptions {
  readonly checks?: "success" | "failed" | "pending" | "partial" | "empty";
  readonly dispatch?: "disabled" | "disabled-punctuated" | "unrelated-422" | "forbidden" | "network" | "success";
  readonly bunMode?: BunMode;
}

function fullReport(head: string, work: string, mode: BunMode): object {
  const names = ["workflow syntax", "generated types are fresh", "generated themes are fresh", "typecheck", "build", "unit tests", "lanes"];
  const steps = names.flatMap((name) => {
    if (mode === "missing-step" && name === "unit tests") return [];
    const failed = mode === "failed-report" && name === "unit tests";
    const skipped = mode === "skipped-step" && name === "lanes";
    return [{
      name,
      command: ["fixture", name],
      cwd: work,
      status: failed ? "failure" : skipped ? "skipped" : "success",
      exitCode: failed ? 1 : skipped ? null : 0,
      signal: null,
      durationMs: 1,
      startedAt: "2026-10-25T00:00:00.000Z",
      endedAt: "2026-10-25T00:00:00.000Z",
      stdout: "",
      stderr: failed ? "fixture failure" : "",
      reason: failed ? "fixture failure" : null,
    }];
  });
  const identity = {
    head,
    branch: "deploy/haemin",
    trackedDiffSha256: "0".repeat(64),
    untrackedFiles: [],
    untrackedFileCount: 0,
    untrackedContentSha256: "0".repeat(64),
    untrackedFilesTruncated: false,
    fingerprint: "0".repeat(64),
    reason: null,
  };
  const revisionSha = mode === "wrong-sha" ? "0".repeat(40) : head;
  return {
    schemaVersion: 1,
    runId: "fixture-full-check",
    status: mode === "failed-report" ? "failure" : "success",
    exitCode: mode === "failed-report" ? 1 : 0,
    startedAt: "2026-10-25T00:00:00.000Z",
    endedAt: "2026-10-25T00:00:01.000Z",
    durationMs: 1000,
    mode: ["full"],
    revision: {
      head: revisionSha,
      testedSha: revisionSha,
      headSha: revisionSha,
      headBranch: "deploy/haemin",
      baseBranch: null,
      baseSha: null,
      branch: "deploy/haemin",
    },
    toolchain: {
      bunVersion: "fixture",
      nodeVersion: null,
      herdrVersion: null,
      herdrTestShards: null,
      platform: "linux",
      arch: "x64",
      ci: false,
    },
    source: { start: identity, end: identity, unchanged: true },
    verification: {
      scope: "source-state-and-step-results",
      browserCurrentSource: "not-claimed",
      status: "verified",
      reason: null,
    },
    currentStep: null,
    steps,
    errors: [],
    browserArtifact: {
      path: "dist",
      buildAttempted: true,
      buildThisRun: true,
      identity: "fixture-artifact",
      finalIdentity: "fixture-artifact",
      unchangedAfterBuild: true,
      provenance: "built-this-run",
    },
    evidence: { logs: [], artifacts: [] },
  };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "fork-release-"));
  roots.push(home);
  const work = join(home, "deploy");
  const origin = join(home, "origin.git");
  const bin = join(home, "bin");
  const stateHome = join(home, "state");
  const state = join(stateHome, "herdr-web-ui-fork-sync");
  const reportSource = join(home, "full-report.json");
  const ghCalls = join(home, "gh.calls");
  const bunCalls = join(home, "bun.calls");
  const gitCalls = join(home, "git.calls");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin, { recursive: true });
  cmd(home, "git", "init", "--bare", origin);
  cmd(home, "git", "init", "-b", "deploy/haemin", work);
  cmd(work, "git", "config", "user.name", "Fixture");
  cmd(work, "git", "config", "user.email", "fixture@example.test");
  cmd(work, "git", "config", "commit.gpgsign", "false");
  cmd(work, "git", "remote", "add", "origin", origin);
  mkdirSync(join(work, "scripts"), { recursive: true });
  copyFileSync(releaseSource, join(work, "scripts/fork-release.sh"));
  chmodSync(join(work, "scripts/fork-release.sh"), 0o755);
  copyFileSync(validatorSource, join(work, "scripts/full-validation-report.sh"));
  writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.2.2"\n}\n');
  writeFileSync(join(work, "herdr-plugin.toml"), 'version = "1.2.2"\n');
  writeFileSync(join(work, "bun.lock"), "fixture lock\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "previous deployment");
  cmd(work, "git", "push", "-u", "origin", "deploy/haemin");
  const previousHead = cmd(work, "git", "rev-parse", "HEAD");
  writeFileSync(join(work, "package.json"), '{\n  "name": "fixture",\n  "version": "1.2.3"\n}\n');
  writeFileSync(join(work, "herdr-plugin.toml"), 'version = "1.2.3"\n');
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "release candidate");
  const head = cmd(work, "git", "rev-parse", "HEAD");

  writeFileSync(join(bin, "git"), String.raw`#!/usr/bin/env bash
printf 'GIT %s\n' "$*" >> "$FAKE_GIT_CALLS"
exec "$REAL_GIT" "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(bin, "gh"), String.raw`#!/usr/bin/env bash
set -eu
printf 'CALL %s\n' "$*" >> "$FAKE_GH_CALLS"
case "$*" in
  *check-runs*)
    case "$FAKE_GH_CHECKS" in
      success) printf '%s\n' '{"total_count":3,"check_runs":[["Fast checks","completed","success","2026-10-25T00:00:00Z"],["Integration and browser","completed","success","2026-10-25T00:00:00Z"],["Native Windows install","completed","success","2026-10-25T00:00:00Z"]]}' ;;
      failed) printf '%s\n' '{"total_count":3,"check_runs":[["Fast checks","completed","success","2026-10-25T00:00:00Z"],["Integration and browser","completed","failure","2026-10-25T00:00:00Z"],["Native Windows install","completed","success","2026-10-25T00:00:00Z"]]}' ;;
      pending) printf '%s\n' '{"total_count":3,"check_runs":[["Fast checks","completed","success","2026-10-25T00:00:00Z"],["Integration and browser","in_progress",null,"2026-10-25T00:00:00Z"],["Native Windows install","completed","success","2026-10-25T00:00:00Z"]]}' ;;
      partial) printf '%s\n' '{"total_count":1,"check_runs":[["Fast checks","completed","success","2026-10-25T00:00:00Z"]]}' ;;
      empty) printf '%s\n' '{"total_count":0,"check_runs":[]}' ;;
      *) exit 72 ;;
    esac
    ;;
  *actions/workflows/ci.yml/dispatches*)
    case "$FAKE_GH_DISPATCH" in
      disabled) printf '%s\n' 'gh: Actions has been disabled for this repository (HTTP 422)' >&2; exit 1 ;;
      disabled-punctuated) printf '%s\n' 'gh: Actions has been disabled for this repository. (HTTP 422)' >&2; exit 1 ;;
      unrelated-422) printf '%s\n' 'gh: Resource not accessible by integration. (HTTP 422)' >&2; exit 1 ;;
      forbidden) printf '%s\n' 'gh: Resource not accessible by integration. (HTTP 403)' >&2; exit 1 ;;
      network) printf '%s\n' 'gh: failed to connect to api.github.com' >&2; exit 1 ;;
      success) exit 0 ;;
      *) exit 73 ;;
    esac
    ;;
  *) exit 74 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "bun"), String.raw`#!/usr/bin/env bash
set -u
printf 'ARGS=%s\n' "$*" >> "$FAKE_BUN_CALLS"
case "$*" in
  'install --frozen-lockfile'|'run check fast'|'run check integration browser') exit 0 ;;
  'run check full')
    printf 'CHECK_REPORT=%s\n' "$CHECK_REPORT" >> "$FAKE_BUN_CALLS"
    case "$FAKE_BUN_MODE" in
      missing-report) rm -f "$CHECK_REPORT" ;;
      malformed-report) printf '%s\n' '{' > "$CHECK_REPORT" ;;
      *) cp "$FAKE_REPORT_SOURCE" "$CHECK_REPORT" ;;
    esac
    case "$FAKE_BUN_MODE" in
      dirty) printf '%s\n' 'dirty after full check' > "$FAKE_REPO/dirty-after-check.txt" ;;
      head-changed) git -C "$FAKE_REPO" commit --allow-empty -m 'fixture moved HEAD' >/dev/null ;;
    esac
    exit 0
    ;;
  *) exit 75 ;;
esac
`);
  chmodSync(join(bin, "bun"), 0o755);

  function run(options: RunOptions = {}) {
    const bunMode = options.bunMode ?? "success";
    const report = fullReport(head, work, bunMode);
    writeFileSync(reportSource, JSON.stringify(report) ?? "");
    return spawnSync(join(work, "scripts/fork-release.sh"), ["1.2.3"], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_STATE_HOME: stateHome,
        FAKE_GH_CHECKS: options.checks ?? "empty",
        FAKE_GH_DISPATCH: options.dispatch ?? "disabled",
        FAKE_GH_CALLS: ghCalls,
        FAKE_BUN_CALLS: bunCalls,
        FAKE_GIT_CALLS: gitCalls,
        REAL_GIT: realGit,
        FAKE_BUN_MODE: bunMode,
        FAKE_REPORT_SOURCE: reportSource,
        FAKE_REPO: work,
      },
    });
  }

  function publishExactHeadBranch(): void {
    cmd(work, "git", "push", "origin", `HEAD:refs/heads/validation/exact-head`);
  }

  return { home, work, origin, state, head, previousHead, ghCalls, bunCalls, gitCalls, run, publishExactHeadBranch };
}

function expectUnreleased(fx: ReturnType<typeof fixture>): void {
  expect(refSha(fx.origin, "refs/heads/deploy/haemin")).toBe(fx.previousHead);
  expect(refSha(fx.origin, "refs/tags/v1.2.3")).toBe("");
  expect(cmd(fx.work, "git", "tag", "--list", "v1.2.3")).toBe("");
}

test("publishes the unchanged HEAD and tag atomically when all hosted checks pass", () => {
  const fx = fixture();
  const result = fx.run({ checks: "success" });
  const status = join(fx.state, "release-1.2.3.status");
  expect(result.status).toBe(0);
  expect(field(status, "state")).toBe("released");
  expect(field(status, "head")).toBe(fx.head);
  expect(refSha(fx.origin, "refs/heads/deploy/haemin")).toBe(fx.head);
  expect(refSha(fx.origin, "refs/tags/v1.2.3")).toBe(fx.head);
  expect(readFileSync(fx.gitCalls, "utf8")).toContain("push --atomic origin HEAD:deploy/haemin refs/tags/v1.2.3");
  expect(readFileSync(fx.gitCalls, "utf8")).not.toContain("--force");
  expect(readFileSync(fx.ghCalls, "utf8")).not.toContain("dispatches");
  expect(readFileSync(fx.bunCalls, "utf8")).not.toContain("run check full");
  expect(readFileSync(fx.bunCalls, "utf8")).toContain("run check integration browser");
  expect(cmd(fx.work, "git", "rev-parse", "HEAD")).toBe(fx.head);
});

for (const scenario of [
  { name: "failed", checks: "failed" },
  { name: "pending", checks: "pending" },
  { name: "nonempty partial", checks: "partial" },
] as const) {
  test(`fails closed for ${scenario.name} hosted checks without dispatch or local bypass`, () => {
    const fx = fixture();
    const result = fx.run({ checks: scenario.checks });
    const status = join(fx.state, "release-1.2.3.status");
    expect(result.status).toBe(1);
    expect(field(status, "state")).toBe("failed");
    expect(readFileSync(fx.ghCalls, "utf8")).not.toContain("dispatches");
    expect(readFileSync(fx.bunCalls, "utf8")).not.toContain("run check full");
    expectUnreleased(fx);
  });
}

test("uses an existing remote branch at the exact HEAD for workflow_dispatch", () => {
  const fx = fixture();
  fx.publishExactHeadBranch();
  const result = fx.run({ dispatch: "disabled", bunMode: "missing-step" });
  expect(result.status).toBe(1);
  expect(readFileSync(fx.ghCalls, "utf8")).toContain("ref=validation/exact-head");
  expect(readFileSync(fx.ghCalls, "utf8")).not.toContain(`ref=${fx.head}`);
});

for (const dispatch of ["disabled", "disabled-punctuated"] as const) {
  test(`uses the validated local full gate for the exact Actions-disabled 422 (${dispatch})`, () => {
    const fx = fixture();
    const result = fx.run({ dispatch });
    const status = join(fx.state, "release-1.2.3.status");
    const reportPath = field(status, "local_gate_report");
    const candidateRef = `refs/heads/release/candidate-1.2.3-${fx.head}`;
    expect(result.status).toBe(0);
    expect(field(status, "state")).toBe("released");
    expect(field(status, "hosted_checks")).toBe("unavailable: Actions disabled by GitHub (422)");
    expect(field(status, "local_gate_report")).toBe(reportPath);
    expect(field(status, "skipped")).toBe("Native Windows install");
    expect(isAbsolute(reportPath)).toBe(true);
    expect(reportPath.startsWith(`${fx.work}/`)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(fx.bunCalls, "utf8")).toContain(`ARGS=run check full\nCHECK_REPORT=${reportPath}`);
    expect(readFileSync(fx.bunCalls, "utf8")).not.toContain("run check integration browser");
    expect(readFileSync(fx.bunCalls, "utf8").match(/^ARGS=run check full$/gm)?.length).toBe(1);
    expect(readFileSync(fx.ghCalls, "utf8")).toContain(`ref=release/candidate-1.2.3-${fx.head}`);
    expect(readFileSync(fx.ghCalls, "utf8")).not.toContain(`ref=${fx.head}\n`);
    expect(refSha(fx.origin, candidateRef)).toBe(fx.head);
    expect(refSha(fx.origin, "refs/heads/deploy/haemin")).toBe(fx.head);
    expect(refSha(fx.origin, "refs/tags/v1.2.3")).toBe(fx.head);
    const gitCalls = readFileSync(fx.gitCalls, "utf8");
    expect(gitCalls).toContain(`push --no-follow-tags origin ${fx.head}:${candidateRef}`);
    expect(gitCalls).toContain("push --atomic origin HEAD:deploy/haemin refs/tags/v1.2.3");
    expect(gitCalls).not.toContain("--force");
  });
}

for (const dispatch of ["unrelated-422", "forbidden", "network"] as const) {
  test(`does not bypass hosted gates for ${dispatch} workflow-dispatch errors`, () => {
    const fx = fixture();
    const result = fx.run({ dispatch });
    const status = join(fx.state, "release-1.2.3.status");
    expect(result.status).toBe(1);
    expect(field(status, "state")).toBe("failed");
    expect(field(status, "hosted_checks")).toBe("");
    expect(field(status, "local_gate_report")).toBe("");
    expect(readFileSync(fx.bunCalls, "utf8")).not.toContain("run check full");
    expect(readFileSync(fx.gitCalls, "utf8")).not.toContain("push --atomic");
    expectUnreleased(fx);
  });
}

test("fails when successful workflow_dispatch produces no hosted checks", () => {
  const fx = fixture();
  const result = fx.run({ dispatch: "success" });
  const status = join(fx.state, "release-1.2.3.status");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(readFileSync(fx.ghCalls, "utf8")).toContain("actions/workflows/ci.yml/dispatches");
  expect(readFileSync(fx.bunCalls, "utf8")).not.toContain("run check full");
  expectUnreleased(fx);
});

for (const mode of ["missing-report", "malformed-report", "failed-report", "skipped-step", "missing-step", "wrong-sha", "dirty", "head-changed"] as const) {
  test(`refuses release when the local full-gate evidence is ${mode}`, () => {
    const fx = fixture();
    fx.publishExactHeadBranch();
    const result = fx.run({ dispatch: "disabled", bunMode: mode });
    const status = join(fx.state, "release-1.2.3.status");
    expect(result.status).toBe(1);
    expect(field(status, "state")).toBe("failed");
    expect(field(status, "hosted_checks")).toBe("unavailable: Actions disabled by GitHub (422)");
    expect(field(status, "local_gate_report")).toBe(join(field(status, "logs"), "local-gate-report.json"));
    expect(field(status, "skipped")).toBe("Native Windows install");
    expect(readFileSync(fx.gitCalls, "utf8")).not.toContain("push ");
    expectUnreleased(fx);
  });
}

test("requires a clean checkout before starting any release gates", () => {
  const fx = fixture();
  writeFileSync(join(fx.work, "dirty-before-release.txt"), "local edit\n");
  const result = fx.run({ checks: "success" });
  expect(result.status).toBe(1);
  expect(existsSync(fx.ghCalls)).toBe(false);
  expect(existsSync(fx.bunCalls)).toBe(false);
  expectUnreleased(fx);
});
