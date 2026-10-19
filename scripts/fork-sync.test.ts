import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const source = resolve(import.meta.dir, "fork-sync.sh");
const promptSource = resolve(import.meta.dir, "fork-sync-prompt.md");
const roots: string[] = [];
const childPids: number[] = [];
afterEach(() => {
  for (const pid of childPids.splice(0)) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cmd(cwd: string, program: string, ...args: string[]): string {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

function field(file: string, key: string): string {
  const prefix = `${key}=`;
  return readFileSync(file, "utf8").split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
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
  copyFileSync(promptSource, join(work, "scripts/fork-sync-prompt.md"));
  writeFileSync(join(work, "fixture.txt"), "base\n");
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "base");
  cmd(work, "git", "push", "-u", "origin", "deploy/haemin");
  cmd(work, "git", "push", "upstream", "HEAD:refs/heads/main");

  const stateHome = join(home, "state");
  const state = join(stateHome, "herdr-web-ui-fork-sync");
  const route = join(home, "route");
  const routeCalls = join(home, "route.calls");
  const gjc = join(home, "gjc");
  const gjcCalls = join(home, "gjc.calls");
  const promptSeen = join(home, "prompt.seen");
  const herdr = join(home, "herdr");
  const herdrCalls = join(home, "herdr.calls");
  writeFileSync(route, `#!/bin/sh
printf '%s\\n' "$*" >> "$ROUTE_CALLS"
[ "$1" = resolve ] && [ "$2" = implement ] && [ "$3" = --field ] || exit 2
case "$4" in
  model) printf '%s\\n' fake-routed-model ;;
  provider) printf '%s\\n' fake-routed-provider ;;
  effort) printf '%s\\n' medium ;;
  *) exit 2 ;;
esac
`);
  chmodSync(route, 0o755);
  writeFileSync(gjc, `#!/usr/bin/env bash
set -uo pipefail
{
  printf 'cwd=%s\\nargs=' "$PWD"
  printf '%s ' "$@"
  printf '\\ntarget=%s\\nworktree=%s\\nbranch=%s\\nstate=%s\\nattempt=%s\\nprevious=%s\\n' \\
    "$FORK_SYNC_TARGET" "$FORK_SYNC_WORKTREE" "$FORK_SYNC_BRANCH" "$FORK_SYNC_STATE_FILE" "$FORK_SYNC_ATTEMPT" "$FORK_SYNC_PREVIOUS_VALIDATED"
} >> "$FAKE_GJC_CALLS"
for arg in "$@"; do
  case "$arg" in
    @*) cat "\${arg#@}" > "$FAKE_GJC_PROMPT" ;;
  esac
done
printf 'fake worker standard output\\n'
finish_merge() { git commit --no-edit >/dev/null 2>&1; }
write_report() {
  local tested_sha="$1" report_mode="$2" report_path="$3"
  python3 - "$report_path" "$tested_sha" "$report_mode" "$FORK_SYNC_BRANCH" "$FORK_SYNC_WORKTREE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
tested_sha, report_mode, branch, worktree = sys.argv[2:]
path.parent.mkdir(parents=True, exist_ok=True)
started = "2026-10-19T00:00:00.000Z"
names = ["workflow syntax", "generated types are fresh", "generated themes are fresh", "typecheck", "build", "unit tests", "lanes"]
commands = {name: ["test-fixture-only", name] for name in names}
steps = []
for name in names:
    if report_mode == "missing-unit-step" and name == "unit tests":
        continue
    if report_mode == "missing-lanes-step" and name == "lanes":
        continue
    failed = report_mode == "failed-step" and name == "unit tests"
    steps.append({
        "name": name,
        "command": commands[name],
        "cwd": worktree,
        "status": "failure" if failed else "success",
        "exitCode": 1 if failed else 0,
        "signal": None,
        "durationMs": 1,
        "startedAt": started,
        "endedAt": started,
        "stdout": "",
        "stderr": "",
        "reason": "fixture failure" if failed else None,
    })
if report_mode in ("auxiliary-step", "failed-auxiliary-step"):
    failed = report_mode == "failed-auxiliary-step"
    steps.append({
        "name": "unpack actionlint",
        "command": ["test-fixture-only", "unpack actionlint"],
        "cwd": worktree,
        "status": "failure" if failed else "success",
        "exitCode": 1 if failed else 0,
        "signal": None,
        "durationMs": 1,
        "startedAt": started,
        "endedAt": started,
        "stdout": "",
        "stderr": "",
        "reason": "fixture failure" if failed else None,
    })
if report_mode == "duplicate-required-gate":
    steps.append(dict(steps[0]))
revision_tested_sha = "0" * 40 if report_mode == "mismatched-tested-sha" else tested_sha
identity = {
    "head": tested_sha,
    "branch": branch,
    "trackedDiffSha256": "0" * 64,
    "untrackedFiles": [],
    "untrackedFileCount": 0,
    "untrackedContentSha256": "0" * 64,
    "untrackedFilesTruncated": False,
    "fingerprint": "0" * 64,
    "reason": None,
}
report = {
    "schemaVersion": 1,
    "runId": "test-fixture-only",
    "status": "success",
    "exitCode": 0,
    "startedAt": started,
    "endedAt": started,
    "durationMs": 7,
    "mode": ["full"],
    "revision": {
        "head": tested_sha,
        "testedSha": revision_tested_sha,
        "headSha": tested_sha,
        "headBranch": branch,
        "baseBranch": None,
        "baseSha": None,
        "branch": branch,
    },
    "toolchain": {
        "bunVersion": "test-fixture-only",
        "nodeVersion": None,
        "herdrVersion": None,
        "herdrTestShards": None,
        "platform": "test-fixture-only",
        "arch": "test-fixture-only",
        "ci": False,
    },
    "source": {"start": identity, "end": identity, "unchanged": True},
    "verification": {
        "scope": "source-state-and-step-results",
        "browserCurrentSource": "not-claimed",
        "status": "verified",
        "reason": None,
    },
    "currentStep": None,
    "steps": steps,
    "errors": [],
    "browserArtifact": {
        "path": "dist",
        "buildAttempted": True,
        "buildThisRun": True,
        "identity": "test-fixture-only",
        "finalIdentity": "test-fixture-only",
        "unchangedAfterBuild": True,
        "provenance": "built-this-run",
    },
    "evidence": {"logs": [], "artifacts": [str(Path(worktree) / "dist")]},
}
path.write_text(json.dumps(report), encoding="utf-8")
PY
}
write_receipt() {
  local candidate="$1" tested_sha="$2" report_mode="\${3:-success}"
  local report_path="$FAKE_GJC_REPORT_DIR/verification-$FORK_SYNC_TARGET-attempt-$FORK_SYNC_ATTEMPT.json" tmp="$FORK_SYNC_STATE_FILE.worker.tmp"
  if [ "$report_mode" = missing-report-file ]; then
    rm -f -- "$report_path"
  else
    write_report "$tested_sha" "$report_mode" "$report_path" || return 1
  fi
  {
    printf 'state=validated\\ntarget=%s\\nattempt=%s\\nupdated_epoch=1\\nupdated_at=fixture\\n' "$FORK_SYNC_TARGET" "$FORK_SYNC_ATTEMPT"
    printf 'branch=%s\\nworktree=%s\\npane=\\nreason=fixture\\nvalidation=local\\ncandidate=%s\\n' "$FORK_SYNC_BRANCH" "$FORK_SYNC_WORKTREE" "$candidate"
    printf 'checks=test fixture only\\nvalidation_report=%s\\nworker_receipt=written-by-worker\\n' "$report_path"
  } > "$tmp"
  mv "$tmp" "$FORK_SYNC_STATE_FILE"
}
case "\${FAKE_GJC_MODE:-success}" in
  hold-fail)
    : > "$FAKE_GJC_READY"
    IFS= read -r _ < "$FAKE_GJC_RELEASE_FIFO"
    exit 23
    ;;
  edit-fail)
    printf 'preserve this candidate edit\\n' > "$FORK_SYNC_WORKTREE/candidate-edit.txt"
    git -C "$FORK_SYNC_WORKTREE" add candidate-edit.txt
    printf 'worker_receipt=kept-after-failure\\n' >> "$FORK_SYNC_STATE_FILE"
    exit 23
    ;;
  exit-fail) exit 23 ;;
  exit0-no-report) exit 0 ;;
  missing-report-file)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate" missing-report-file
    ;;
  mismatched-tested-sha)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate" mismatched-tested-sha
    ;;
  missing-unit-step|missing-lanes-step|failed-step)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate" "$FAKE_GJC_MODE"
    ;;
  auxiliary-step|failed-auxiliary-step|duplicate-required-gate)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate" "$FAKE_GJC_MODE"
    ;;
  mismatch-head)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate"
    git commit --allow-empty -m 'advance after validation report' >/dev/null 2>&1 || exit 25
    ;;
  unrelated-report)
    git merge --abort >/dev/null 2>&1 || exit 24
    git commit --allow-empty -m 'unrelated candidate revision' >/dev/null 2>&1 || exit 25
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate"
    ;;
  success)
    finish_merge || exit 24
    candidate="$(git rev-parse HEAD)"
    write_receipt "$candidate" "$candidate"
    ;;
  *) exit 26 ;;
esac
`);
  chmodSync(gjc, 0o755);
  writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_CALLS"
exit 77
`);
  chmodSync(herdr, 0o755);

  const baseEnv = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    // A sync worker inherits its real deploy root. Fixtures must never use that checkout.
    FORK_SYNC_REPO: work,
    ROUTE_CALLS: routeCalls,
    FORK_SYNC_ROUTE_BIN: route,
    FORK_SYNC_GJC_BIN: gjc,
    FAKE_GJC_CALLS: gjcCalls,
    FAKE_GJC_PROMPT: promptSeen,
    FAKE_GJC_REPORT_DIR: join(home, "_artifacts", "fork-sync"),
    HERDR_BIN_PATH: herdr,
    HERDR_CALLS: herdrCalls,
  };
  const argsFor = (options: { dry?: boolean; retryDelay?: number; mode?: string; repo?: string; launcher?: string; ready?: string; releaseFifo?: string; oldLauncherCalls?: string } = {}) => {
    const launcher = options.launcher ?? join(work, "scripts/fork-sync.sh");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      HERDR_FORK_SYNC_RETRY_SECONDS: String(options.retryDelay ?? 0),
      FAKE_GJC_MODE: options.mode ?? "success",
      ...(options.repo ? { FORK_SYNC_REPO: options.repo } : {}),
      ...(options.ready ? { FAKE_GJC_READY: options.ready } : {}),
      ...(options.releaseFifo ? { FAKE_GJC_RELEASE_FIFO: options.releaseFifo } : {}),
      ...(options.oldLauncherCalls ? { OLD_LAUNCHER_CALLS: options.oldLauncherCalls } : {}),
    };
    return { launcher, env };
  };
  const run = (options: Parameters<typeof argsFor>[0] = {}) => {
    const { launcher, env } = argsFor(options);
    return spawnSync("bash", [launcher, ...(options.dry ? ["--dry-run"] : [])], { cwd: work, encoding: "utf8", env });
  };
  const start = (options: Parameters<typeof argsFor>[0] = {}) => {
    const { launcher, env } = argsFor(options);
    const child = spawn("bash", [launcher, ...(options.dry ? ["--dry-run"] : [])], { cwd: work, env, detached: true });
    if (child.pid) childPids.push(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolvePromise) => {
      child.once("close", (code, signal) => {
        if (child.pid) {
          const index = childPids.indexOf(child.pid);
          if (index >= 0) childPids.splice(index, 1);
        }
        resolvePromise({ code, signal, stdout, stderr });
      });
    });
    return { finished };
  };
  const statusFile = (target: string) => join(state, `main-${target}.status`);
  const candidateTree = (target: string) => join(home, `sync-upstream-main-${target.slice(0, 12)}`);
  const herdrCallCount = () => existsSync(herdrCalls) ? readFileSync(herdrCalls, "utf8").trim().split("\n").filter(Boolean).length : 0;
  return { home, work, origin, upstream, state, routeCalls, gjcCalls, promptSeen, herdrCallCount, run, start, statusFile, candidateTree };
}

function waitForFile(path: string, timeoutMs = 8_000): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dirname(path), (_event, name) => {
      if (String(name) === basename(path) && existsSync(path)) {
        if (timer) clearTimeout(timer);
        watcher.close();
        resolvePromise();
      }
    });
    watcher.once("error", (error) => {
      if (timer) clearTimeout(timer);
      watcher.close();
      reject(error);
    });
    timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`timed out waiting for ${path}`));
    }, timeoutMs);
    if (existsSync(path)) {
      if (timer) clearTimeout(timer);
      watcher.close();
      resolvePromise();
    }
  });
}

function advanceUpstream(home: string, upstream: string, number: number) {
  const peer = join(home, `upstream-peer-${number}`);
  cmd(home, "git", "clone", "--branch", "main", upstream, peer);
  cmd(peer, "git", "config", "user.name", "Fixture");
  cmd(peer, "git", "config", "user.email", "fixture@example.test");
  writeFileSync(join(peer, `upstream-${number}.txt`), `upstream main change ${number}\n`);
  cmd(peer, "git", "add", ".");
  cmd(peer, "git", "commit", "-m", `advance upstream main ${number}`);
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
  const { home, work, upstream, state, run, herdrCallCount } = fixture();
  advanceUpstream(home, upstream, 1);
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
  expect(herdrCallCount()).toBe(0);
});

test("uses routed headless GJC with expanded context, a private log and no native calls", () => {
  const { home, upstream, run, statusFile, candidateTree, routeCalls, gjcCalls, promptSeen, herdrCallCount } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run();
  const status = statusFile(target);
  const logPath = field(status, "log");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("validated");
  expect(field(status, "state")).toBe("validated");
  expect(field(status, "validation")).toBe("local");
  expect(field(status, "target")).toBe(target);
  expect(field(status, "candidate")).toBe(cmd(candidateTree(target), "git", "rev-parse", "HEAD"));
  expect(field(status, "runtime")).toBe("headless");
  expect(field(status, "worker_receipt")).toBe("written-by-worker");
  expect(logPath).toContain(`main-${target}.attempt-1.log`);
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(logPath, "utf8")).toContain("fake worker standard output");
  expect(result.stdout).not.toContain("fake worker standard output");
  expect(readFileSync(routeCalls, "utf8")).toContain("resolve implement --field model");
  expect(readFileSync(routeCalls, "utf8")).toContain("resolve implement --field provider");
  expect(readFileSync(routeCalls, "utf8")).toContain("resolve implement --field effort");
  expect(readFileSync(gjcCalls, "utf8")).toContain(`cwd=${candidateTree(target)}`);
  expect(readFileSync(gjcCalls, "utf8")).toContain("--mode json --no-pty --provider fake-routed-provider --model fake-routed-model --thinking medium");
  expect(readFileSync(gjcCalls, "utf8")).toContain(`target=${target}`);
  expect(readFileSync(gjcCalls, "utf8")).toContain(`worktree=${candidateTree(target)}`);
  expect(readFileSync(promptSeen, "utf8")).toContain(`FORK_SYNC_TARGET=${target}`);
  expect(readFileSync(promptSeen, "utf8")).toContain(`FORK_SYNC_WORKTREE=${candidateTree(target)}`);
  expect(readFileSync(promptSeen, "utf8")).not.toContain("$FORK_SYNC_TARGET");
  expect(herdrCallCount()).toBe(0);
  expect(spawnSync("git", ["merge-base", "--is-ancestor", target, "HEAD"], { cwd: candidateTree(target) }).status).toBe(0);
  expect(spawnSync("git", ["status", "--porcelain"], { cwd: candidateTree(target), encoding: "utf8" }).stdout).toBe("");
});

test("exit zero without validation evidence is recorded as failed", () => {
  const { home, upstream, run, statusFile, herdrCallCount } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "exit0-no-report" });
  const status = statusFile(target);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("without valid validation evidence");
  expect(field(status, "state")).toBe("failed");
  expect(field(status, "reason")).toContain("without matching validation evidence");
  expect(field(status, "validation_report")).toBe("");
  expect(herdrCallCount()).toBe(0);
});

test("nonzero worker exit is failed and preserves its detailed receipt", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "edit-fail" });
  const status = statusFile(target);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("headless GJC failed with status 23");
  expect(field(status, "state")).toBe("failed");
  expect(field(status, "worker_receipt")).toBe("kept-after-failure");
  expect(readFileSync(join(home, `sync-upstream-main-${target.slice(0, 12)}`, "candidate-edit.txt"), "utf8")).toBe("preserve this candidate edit\n");
});

test("accepts the actual full-check report shape from an on-disk fixture file", () => {
  const success = fixture();
  const successTarget = advanceUpstream(success.home, success.upstream, 1);
  expect(success.run().status).toBe(0);
  const successStatus = success.statusFile(successTarget);
  expect(field(successStatus, "state")).toBe("validated");
  const reportPath = field(successStatus, "validation_report");
  expect(isAbsolute(reportPath)).toBe(true);
  expect(existsSync(reportPath)).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    mode: string[];
    revision: { testedSha: string };
    steps: { name: string; status: string; exitCode: number }[];
  };
  expect(report.mode).toEqual(["full"]);
  expect(report.revision.testedSha).toBe(field(successStatus, "candidate"));
  expect(report.steps.map((step) => step.name)).toEqual([
    "workflow syntax", "generated types are fresh", "generated themes are fresh",
    "typecheck", "build", "unit tests", "lanes",
  ]);
  expect(field(successStatus, "worker_receipt")).toBe("written-by-worker");
});

test("accepts successful auxiliary steps after all required full-check gates", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "auxiliary-step" });
  const status = statusFile(target);
  const report = JSON.parse(readFileSync(field(status, "validation_report"), "utf8")) as {
    steps: { name: string; status: string; exitCode: number }[];
  };
  expect(result.status).toBe(0);
  expect(field(status, "state")).toBe("validated");
  expect(report.steps.at(-1)).toMatchObject({ name: "unpack actionlint", status: "success", exitCode: 0 });
});

test("rejects a failed auxiliary full-check step", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "failed-auxiliary-step" });
  const status = statusFile(target);
  const report = JSON.parse(readFileSync(field(status, "validation_report"), "utf8")) as {
    steps: { name: string; status: string; exitCode: number }[];
  };
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(report.steps.at(-1)).toMatchObject({ name: "unpack actionlint", status: "failure", exitCode: 1 });
});

test("rejects a duplicated required full-check gate", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "duplicate-required-gate" });
  const status = statusFile(target);
  const report = JSON.parse(readFileSync(field(status, "validation_report"), "utf8")) as { steps: { name: string }[] };
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(report.steps.filter((step) => step.name === "workflow syntax")).toHaveLength(2);
});

test("rejects a full-check report whose tested SHA differs from the candidate", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "mismatched-tested-sha" });
  const status = statusFile(target);
  const reportPath = field(status, "validation_report");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(field(status, "reason")).toContain("without matching validation evidence");
  expect(isAbsolute(reportPath)).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { revision: { testedSha: string } };
  expect(report.revision.testedSha).not.toBe(field(status, "candidate"));
});

test("rejects a full-check report missing the unit tests step", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "missing-unit-step" });
  const status = statusFile(target);
  const reportPath = field(status, "validation_report");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(isAbsolute(reportPath)).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: { name: string }[] };
  expect(report.steps.some((step) => step.name === "unit tests")).toBe(false);
});

test("rejects a full-check report missing the lanes step", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "missing-lanes-step" });
  const status = statusFile(target);
  const reportPath = field(status, "validation_report");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(isAbsolute(reportPath)).toBe(true);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: { name: string }[] };
  expect(report.steps.some((step) => step.name === "lanes")).toBe(false);
});

test("rejects a failed step in an otherwise successful full-check report", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "failed-step" });
  const status = statusFile(target);
  const reportPath = field(status, "validation_report");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: { status: string; exitCode: number }[] };
  expect(report.steps.some((step) => step.status !== "success" || step.exitCode !== 0)).toBe(true);
});

test("rejects a full-check report path when its JSON file is missing", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "missing-report-file" });
  const status = statusFile(target);
  const reportPath = field(status, "validation_report");
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(isAbsolute(reportPath)).toBe(true);
  expect(existsSync(reportPath)).toBe(false);
});

test("keeps an immutable validated reference when its candidate worktree is dirty and newer", () => {
  const { home, upstream, run, statusFile, candidateTree, gjcCalls } = fixture();
  const firstTarget = advanceUpstream(home, upstream, 1);
  expect(run().status).toBe(0);
  const firstCandidate = cmd(candidateTree(firstTarget), "git", "rev-parse", "HEAD");
  const firstCallCount = readFileSync(gjcCalls, "utf8").split("cwd=").length - 1;

  const repeated = run();
  expect(repeated.status).toBe(0);
  expect(repeated.stdout).toContain("is validated");
  expect(readFileSync(gjcCalls, "utf8").split("cwd=").length - 1).toBe(firstCallCount);
  expect(field(statusFile(firstTarget), "attempt")).toBe("1");

  const firstTree = candidateTree(firstTarget);
  const firstReportPath = field(statusFile(firstTarget), "validation_report");
  const sourceHead = cmd(join(home, "deploy"), "git", "rev-parse", "HEAD");
  const sourceChanges = cmd(join(home, "deploy"), "git", "status", "--porcelain");
  cmd(firstTree, "git", "commit", "--allow-empty", "-m", "unrelated automation advance");
  writeFileSync(join(firstTree, "automation-change.txt"), "unrelated automation edit\n");
  const secondTarget = advanceUpstream(home, upstream, 2);
  expect(run().status).toBe(0);
  expect(readFileSync(gjcCalls, "utf8")).toContain(`previous=${firstCandidate}`);
  expect(existsSync(candidateTree(firstTarget))).toBe(true);
  expect(field(statusFile(secondTarget), "state")).toBe("validated");
  const previousReport = JSON.parse(readFileSync(firstReportPath, "utf8")) as { revision: { testedSha: string } };
  expect(previousReport.revision.testedSha).toBe(firstCandidate);
  expect(cmd(join(home, "deploy"), "git", "rev-parse", "HEAD")).toBe(sourceHead);
  expect(cmd(join(home, "deploy"), "git", "status", "--porcelain")).toBe(sourceChanges);
});

test("does not skip a current target when its validated candidate HEAD is newer and dirty", () => {
  const { home, upstream, run, statusFile, candidateTree, gjcCalls } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  expect(run().status).toBe(0);
  const tree = candidateTree(target);
  cmd(tree, "git", "commit", "--allow-empty", "-m", "unrelated automation advance");
  writeFileSync(join(tree, "automation-change.txt"), "unrelated automation edit\n");

  expect(run({ mode: "exit-fail" }).status).toBe(1);
  expect(field(statusFile(target), "state")).toBe("failed");
  expect(field(statusFile(target), "attempt")).toBe("2");
  expect(readFileSync(gjcCalls, "utf8").split("cwd=").length - 1).toBe(2);
});

test("matching metadata cannot validate a candidate without target ancestry", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "unrelated-report" });
  const status = statusFile(target);
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(field(status, "reason")).toContain("without matching validation evidence");
  expect(spawnSync("git", ["merge-base", "--is-ancestor", target, "HEAD"], { cwd: join(home, `sync-upstream-main-${target.slice(0, 12)}`) }).status).toBe(1);
});

test("rejects a candidate HEAD changed after its validation report", () => {
  const { home, upstream, run, statusFile } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const result = run({ mode: "mismatch-head" });
  const status = statusFile(target);
  expect(result.status).toBe(1);
  expect(field(status, "state")).toBe("failed");
  expect(field(status, "reason")).toContain("without matching validation evidence");
  expect(field(status, "candidate")).not.toBe(cmd(join(home, `sync-upstream-main-${target.slice(0, 12)}`), "git", "rev-parse", "HEAD"));
});

test("retries in the same candidate without changing user edits, index or unknown receipt fields", () => {
  const { home, upstream, run, statusFile, candidateTree } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  const first = run({ mode: "edit-fail" });
  const tree = candidateTree(target);
  expect(first.status).toBe(1);
  const stagedBefore = cmd(tree, "git", "diff", "--cached", "--binary");
  const stateBefore = cmd(tree, "git", "status", "--porcelain");
  const second = run({ mode: "exit-fail" });
  const status = statusFile(target);
  expect(second.status).toBe(1);
  expect(field(status, "attempt")).toBe("2");
  expect(field(status, "state")).toBe("failed");
  expect(readFileSync(status, "utf8")).toContain("worker_receipt=kept-after-failure");
  expect(cmd(tree, "git", "diff", "--cached", "--binary")).toBe(stagedBefore);
  expect(cmd(tree, "git", "status", "--porcelain")).toBe(stateBefore);
  expect(existsSync(join(tree, "candidate-edit.txt"))).toBe(true);
});

test("global foreground lock coalesces newer upstream commits into the next poll", async () => {
  const { home, upstream, run, start, candidateTree, statusFile } = fixture();
  const firstTarget = advanceUpstream(home, upstream, 1);
  const ready = join(home, "worker.ready");
  const releaseFifo = join(home, "worker.release");
  cmd(home, "mkfifo", releaseFifo);
  const first = start({ mode: "hold-fail", ready, releaseFifo });
  await waitForFile(ready);
  const fetchHead = join(home, "deploy", ".git/FETCH_HEAD");
  const fetchHeadBeforeOverlap = readFileSync(fetchHead, "utf8");

  const intermediateTarget = advanceUpstream(home, upstream, 2);
  const latestTarget = advanceUpstream(home, upstream, 3);
  const overlappingPoll = run();
  expect(overlappingPoll.status).toBe(0);
  expect(overlappingPoll.stdout).toContain("another sync check is running");
  expect(readFileSync(fetchHead, "utf8")).toBe(fetchHeadBeforeOverlap);
  expect(existsSync(candidateTree(intermediateTarget))).toBe(false);
  expect(existsSync(candidateTree(latestTarget))).toBe(false);

  writeFileSync(releaseFifo, "continue\n");
  const firstResult = await first.finished;
  expect(firstResult.code).toBe(1);
  expect(field(statusFile(firstTarget), "state")).toBe("failed");

  const nextPoll = run();
  expect(nextPoll.status).toBe(0);
  expect(field(statusFile(latestTarget), "state")).toBe("validated");
  expect(existsSync(candidateTree(latestTarget))).toBe(true);
  expect(existsSync(candidateTree(intermediateTarget))).toBe(false);
});

test("invoked launcher policy survives deploy refresh through FORK_SYNC_REPO", () => {
  const { home, work, upstream, run, statusFile, promptSeen, candidateTree, herdrCallCount } = fixture();
  const artifact = join(home, "launcher-artifact");
  const artifactScripts = join(artifact, "scripts");
  mkdirSync(artifactScripts, { recursive: true });
  const launcher = join(artifactScripts, "fork-sync.sh");
  copyFileSync(source, launcher);
  chmodSync(launcher, 0o755);
  copyFileSync(promptSource, join(artifactScripts, "fork-sync-prompt.md"));
  writeFileSync(join(artifactScripts, "fork-sync-prompt.md"), `${readFileSync(join(artifactScripts, "fork-sync-prompt.md"), "utf8")}\nartifact-policy-marker\n`);

  writeFileSync(join(work, "scripts/fork-sync.sh"), `#!/bin/sh
printf '%s\\n' old-launcher >> "$OLD_LAUNCHER_CALLS"
exit 45
`);
  chmodSync(join(work, "scripts/fork-sync.sh"), 0o755);
  writeFileSync(join(work, "scripts/fork-sync-prompt.md"), "deployed-old-policy-marker\n");
  cmd(work, "git", "add", "scripts/fork-sync.sh", "scripts/fork-sync-prompt.md");
  cmd(work, "git", "commit", "-m", "replace deployed sync policy");
  cmd(work, "git", "push", "origin", "deploy/haemin");

  const target = advanceUpstream(home, upstream, 1);
  const oldLauncherCalls = join(home, "old-launcher.calls");
  const result = run({ launcher, repo: work, oldLauncherCalls });
  const status = statusFile(target);
  expect(result.status).toBe(0);
  expect(cmd(work, "git", "rev-parse", "HEAD")).toBe(cmd(work, "git", "rev-parse", "origin/deploy/haemin"));
  expect(existsSync(oldLauncherCalls)).toBe(false);
  expect(readFileSync(promptSeen, "utf8")).toContain("artifact-policy-marker");
  expect(readFileSync(promptSeen, "utf8")).not.toContain("deployed-old-policy-marker");
  expect(field(status, "state")).toBe("validated");
  expect(existsSync(candidateTree(target))).toBe(true);
  expect(herdrCallCount()).toBe(0);
});

test("records deploy containment without starting a worker", () => {
  const { work, state, run, statusFile, herdrCallCount } = fixture();
  const target = cmd(work, "git", "rev-parse", "HEAD");
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("is contained");
  expect(field(statusFile(target), "state")).toBe("contained");
  expect(existsSync(join(state, `main-${target}.agent.lock`))).toBe(false);
  expect(herdrCallCount()).toBe(0);
});

test("a stale validated marker without matching evidence starts a retry", () => {
  const { home, upstream, state, run, statusFile, gjcCalls } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  mkdirSync(state, { recursive: true });
  writeFileSync(statusFile(target), `state=validated\ntarget=${target}\nattempt=1\nupdated_epoch=0\nvalidation=local\ncandidate=${target}\npane=legacy-pane\n`);
  const result = run({ mode: "exit-fail" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("validated receipt is stale or incomplete");
  expect(readFileSync(gjcCalls, "utf8")).toContain(`target=${target}`);
  expect(field(statusFile(target), "state")).toBe("failed");
  expect(field(statusFile(target), "attempt")).toBe("2");
  expect(field(statusFile(target), "pane")).toBe("legacy-pane");
});

test("failed attempts respect the configured retry backoff", () => {
  const { home, upstream, state, run, statusFile, gjcCalls, candidateTree } = fixture();
  const target = advanceUpstream(home, upstream, 1);
  mkdirSync(state, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(statusFile(target), `state=failed\ntarget=${target}\nattempt=4\nupdated_epoch=${now}\nbranch=sync/upstream-main-${target.slice(0, 12)}\n`);
  const result = run({ retryDelay: 3600 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("retry is available after 3600 seconds");
  expect(field(statusFile(target), "attempt")).toBe("4");
  expect(existsSync(gjcCalls)).toBe(false);
  expect(existsSync(candidateTree(target))).toBe(false);
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
  expect(result.stdout).toContain("origin is not a fast-forward");
  expect(cmd(work, "git", "rev-parse", "HEAD")).toBe(head);
  expect(readdirSync(state).filter((name) => name.endsWith(".status"))).toEqual([]);
});
