import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const source = join(import.meta.dir, "fork-release.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function cmd(cwd: string, program: string, ...args: string[]): string {
  return execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
}

function fixture(version = "0.4.1109", checks = "Fast checks\tcompleted\tsuccess\nIntegration and browser\tcompleted\tsuccess\nNative Windows install\tcompleted\tsuccess") {
  const home = mkdtempSync(join(tmpdir(), "fork-release-"));
  roots.push(home);
  const work = join(home, "deploy");
  const origin = join(home, "origin.git");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  cmd(home, "git", "init", "--bare", origin);
  cmd(home, "git", "init", "-b", "deploy/haemin", work);
  cmd(work, "git", "config", "user.name", "Fixture");
  cmd(work, "git", "config", "user.email", "fixture@example.test");
  cmd(work, "git", "config", "commit.gpgsign", "false");
  cmd(work, "git", "remote", "add", "origin", origin);
  cmd(work, "mkdir", "-p", "scripts");
  copyFileSync(source, join(work, "scripts/fork-release.sh"));
  chmodSync(join(work, "scripts/fork-release.sh"), 0o755);
  writeFileSync(join(work, "package.json"), JSON.stringify({ version: "0.4.1108" }, null, 2));
  writeFileSync(join(work, "herdr-plugin.toml"), 'id = "haeminway1.herdr-web-ui"\nversion = "0.4.1108"\n');
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "published baseline");
  cmd(work, "git", "tag", "v0.4.1108");
  cmd(work, "git", "push", "-u", "origin", "deploy/haemin", "v0.4.1108");
  writeFileSync(join(work, "package.json"), JSON.stringify({ version }, null, 2));
  writeFileSync(join(work, "herdr-plugin.toml"), `id = "haeminway1.herdr-web-ui"\nversion = "${version}"\n`);
  cmd(work, "git", "add", ".");
  cmd(work, "git", "commit", "-m", "release candidate");
  cmd(work, "git", "push", "origin", "deploy/haemin");

  const realGit = (process.env["PATH"] ?? "").split(delimiter).map((dir) => join(dir, "git")).find(existsSync);
  if (!realGit) throw new Error("git executable is unavailable");
  const bunLog = join(home, "bun.calls");
  const gitLog = join(home, "git.release.calls");
  const fakeBun = join(bin, "bun");
  writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${bunLog}'\n`);
  chmodSync(fakeBun, 0o755);
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_GH_CHECKS\"\n");
  chmodSync(fakeGh, 0o755);
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = -C ]; then shift; repository=$1; shift; else repository=.; fi
if [ "$1" = tag ]; then printf 'tag\\n' >> "$FAKE_GIT_LOG"; exit 0; fi
if [ "$1" = push ] && [ "$2" = --atomic ]; then printf 'push\\n' >> "$FAKE_GIT_LOG"; exit 0; fi
exec "$REAL_GIT" -C "$repository" "$@"
`);
  chmodSync(fakeGit, 0o755);
  const run = (requestedVersion = version) => spawnSync("bash", [join(work, "scripts/fork-release.sh"), requestedVersion], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, "state"),
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      REAL_GIT: realGit,
      FAKE_GH_CHECKS: checks,
      FAKE_GIT_LOG: gitLog,
    },
  });
  return { home, work, origin, bunLog, gitLog, run };
}

test("release requests every local and exact-commit gate before attempting a tag or push", () => {
  const { origin, bunLog, gitLog, run } = fixture();
  const result = run();
  expect(result.status).toBe(0);
  expect(readFileSync(bunLog, "utf8")).toContain("install --frozen-lockfile");
  expect(readFileSync(bunLog, "utf8")).toContain("run check fast");
  expect(readFileSync(bunLog, "utf8")).toContain("run check integration browser");
  expect(readFileSync(gitLog, "utf8")).toBe("tag\npush\n");
  expect(cmd(origin, "git", "show-ref")).not.toContain("v0.4.1109");
});

test("a missing Native Windows install gate stops before tag or push", () => {
  const { origin, gitLog, run } = fixture("0.4.1109", "Fast checks\tcompleted\tsuccess\nIntegration and browser\tcompleted\tsuccess");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Native Windows install");
  expect(existsSync(gitLog)).toBe(false);
  expect(cmd(origin, "git", "show-ref")).not.toContain("v0.4.1109");
});

test("a version older than the published fork tag is refused", () => {
  const { origin, run } = fixture("0.4.1107");
  const result = run("0.4.1107");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("older than a published fork tag");
  expect(cmd(origin, "git", "show-ref")).not.toContain("v0.4.1107");
});
