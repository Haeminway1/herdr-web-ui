import { homedir } from "node:os";
import { join } from "node:path";
import { legacyName } from "../legacy-env.ts";

/** Where `cargo build --release` in crates/pty-sidecar puts the Rust PTY host. */
export const RUST_SIDECAR_BUILD = join(import.meta.dir, "..", "..", "crates", "pty-sidecar", "target", "release", "ovis-pty-sidecar");

export type RustHostVerdict = { ok: true } | { ok: false; reason: string };

const verdicts = new Map<string, RustHostVerdict>();
const said = new Set<string>();
let disabled = false;

/** Says `message` once per process: a warning (or log line) about the host, never one per attach. */
function once(message: string, print: (message: string) => void = console.error): void {
  if (said.has(message)) return;
  said.add(message);
  print(message);
}

/** Why a spawn threw: its errno code (ENOENT, EACCES, ENOEXEC) when it has one. */
export function spawnErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return "code" in error && error.code != null ? String(error.code) : error.message;
}

/** The configured binary, expanding only a leading home-directory shorthand. */
export function rustSidecarPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const binary = env["OVIS_PTY_SIDECAR_BIN"] || RUST_SIDECAR_BUILD;
  if (binary === "~") return home;
  return binary.startsWith("~/") ? join(home, binary.slice(2)) : binary;
}

/**
 * Checks the host's identity and its PTY path before it is allowed to serve attachments, in at most
 * 2 x timeoutMs: a run past its time is killed with SIGKILL, since the host (or a binary posing as it)
 * may outlive SIGTERM, and the server's start waits on this check.
 */
export function probeRustHost(binary: string, env: Record<string, string | undefined> = process.env, timeoutMs = 3000): RustHostVerdict {
  const clean = { ...env };
  delete clean["OVIS_TOKEN"];
  const legacyToken = legacyName("OVIS_TOKEN");
  if (legacyToken !== null) delete clean[legacyToken];
  try {
    for (const identity of [true, false]) {
      const result = Bun.spawnSync(identity ? [binary] : [binary, "1", "1", "true"], {
        env: clean, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL",
      });
      if (result.exitedDueToTimeout) return { ok: false, reason: `no answer in ${timeoutMs} ms` };
      if (result.signalCode != null) return { ok: false, reason: result.signalCode };
      const first = result.stderr.toString().split("\n")[0] ?? "";
      const exit = `exit ${result.exitCode}${first ? `: ${first}` : ""}`;
      if (identity && (result.exitCode !== 2 || !first.startsWith("pty-sidecar: usage:"))) return { ok: false, reason: `not the Rust PTY host (${exit})` };
      if (!identity && result.exitCode !== 0) return { ok: false, reason: exit };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: spawnErrorReason(error) };
  }
}

/**
 * The Rust PTY host to run, when OVIS_PTY_SIDECAR=rust asks for it (OVIS_PTY_SIDECAR_BIN, else the release
 * build): it takes pty-host.mjs's arguments and frames. Node is the default and the fallback.
 */
export function rustSidecar(env: Record<string, string | undefined> = process.env): string | null {
  if (process.platform === "win32") return null;
  const choice = env["OVIS_PTY_SIDECAR"];
  if (!choice || choice === "node") return null;
  if (choice !== "rust") {
    once(`OVIS_PTY_SIDECAR=${choice}: expected "node" or "rust"; using the Node PTY sidecar`);
    return null;
  }
  if (disabled) return null;
  const binary = rustSidecarPath(env);
  let verdict = verdicts.get(binary);
  if (!verdict) {
    verdict = probeRustHost(binary, env);
    verdicts.set(binary, verdict);
  }
  if (!verdict.ok) {
    once(`OVIS_PTY_SIDECAR=rust: ${binary}: ${verdict.reason}; using the Node PTY sidecar (build it with cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml, or set OVIS_PTY_SIDECAR_BIN to the built binary's absolute path: an update installed from the app runs from ~/.config/ovis/updates, where the default path does not exist)`);
    return null;
  }
  once(`PTY host: Rust (${binary})`, console.log);
  return binary;
}

/** Stops starting Rust hosts until this server restarts. */
export function disableRustHost(reason: string): void {
  if (disabled) return;
  disabled = true;
  once(`OVIS_PTY_SIDECAR=rust: ${reason}; using the Node PTY sidecar until this server restarts`);
}

/** Forgets cached verdicts, the disable and what was said. Tests only. */
export function resetPtyHostForTests(): void {
  verdicts.clear();
  said.clear();
  disabled = false;
}
