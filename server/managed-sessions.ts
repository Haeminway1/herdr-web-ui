/** Read-only chat identity. Recovery eligibility is owned by Manager, not the transcript reader. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { HerdrPane, ManagedSessionIdentity, SessionSnapshot } from "../shared/protocol.ts";
import { gjcSdkCurrentSession } from "./gjc-sdk.ts";

interface ProcessIdentity { pid: number; starttime: string; boot: string; cwd: string }
export interface ManagedSessionDeps {
  gjcSession?: typeof gjcSdkCurrentSession;
  processIdentity?: (pid: number) => ProcessIdentity | null;
}

function processIdentity(pid: number): ProcessIdentity | null {
  try {
    if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0 || !owned(statSync(`/proc/${pid}`))) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    if (fields[0] === "Z" || !/^[0-9]+$/.test(fields[19] ?? "")) return null;
    return { pid, starttime: fields[19]!, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), cwd: realpathSync(readlinkSync(`/proc/${pid}/cwd`)) };
  } catch { return null; }
}

type Harness = NonNullable<ManagedSessionIdentity["harness"]>;
export interface ManagedSessionResolution {
  identity: ManagedSessionIdentity;
  sessionFile: string | null;
}

export function managedNamespace(): string {
  return process.env["HERDR_MANAGED_NAMESPACE"] ?? join(homedir(), "dev/agents/herdr_manager/state/managed-sessions");
}

const HARNESSES = new Set<string>(["gjc", "omo", "codex", "claude"]);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REASON = /^(?:blocked_[a-z0-9_]{1,64}|identity_pending)$/;

function owned(info: { uid: number; mode: number }): boolean {
  return (process.getuid === undefined || info.uid === process.getuid()) && (info.mode & 0o022) === 0;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface FileIdentityPin { readonly dev: number; readonly ino: number }
type TranscriptPermission = "strict" | "omo-private-store";

function fileIdentityPin(value: unknown): FileIdentityPin | null {
  const pin = object(value);
  if (!pin || typeof pin.dev !== "number" || !Number.isSafeInteger(pin.dev) || pin.dev < 0 || typeof pin.ino !== "number" || !Number.isSafeInteger(pin.ino) || pin.ino < 0) return null;
  return { dev: pin.dev, ino: pin.ino };
}

function privateStore(info: { uid: number; mode: number; isDirectory(): boolean }): boolean {
  return info.isDirectory() && owned(info) && (info.mode & 0o077) === 0;
}

function transcriptPermission(
  info: { uid: number; mode: number },
  harness: Harness,
  pinMatches: boolean,
  storeInfo: { uid: number; mode: number; isDirectory(): boolean },
): TranscriptPermission | null {
  if (owned(info)) return "strict";
  if (harness !== "omo" || !pinMatches || (process.getuid !== undefined && info.uid !== process.getuid())
    || (info.mode & 0o020) === 0 || (info.mode & 0o002) !== 0 || !privateStore(storeInfo)) return null;
  return "omo-private-store";
}

function recordAt(path: string): { record: Record<string, unknown> | null; unsafe: boolean } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.size > 65536) return { record: null, unsafe: true };
    const buffer = Buffer.alloc(65537);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return count > 65536 ? { record: null, unsafe: true } : { record: object(JSON.parse(buffer.subarray(0, count).toString("utf8"))), unsafe: false };
  } finally { closeSync(fd); }
}

function bindingKey(record: Record<string, unknown> | null): string {
  return JSON.stringify(["nonce", "generation", "harness", "launcher_harness", "cwd", "pane_id", "workspace_id", "terminal_id", "desired_state", "state", "error", "session_id", "session_file", "session_dir", "child", "file_identity"].map(key => record?.[key]));
}

/** Codex's first row allows 1 MiB including newline; other identity/prefix rows allow 16 KiB. */
function header(path: string, harness: Harness): { id: unknown; cwd: unknown } | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const limit = harness === "codex" ? 1024 * 1024 : 16384;
    let buffer = Buffer.alloc(16385);
    let offset = 0;
    for (let row = 0; row < (harness === "claude" ? 32 : 1); row++) {
      let count = 0;
      let newline = -1;
      while (newline < 0) {
        const added = readSync(fd, buffer, count, buffer.length - count, offset + count);
        if (added === 0) return null;
        newline = buffer.subarray(count, count + added).indexOf(10);
        if (newline >= 0) newline += count;
        count += added;
        if (newline >= 0) break;
        if (count > limit) return null;
        if (count === buffer.length) {
          const grown = Buffer.alloc(Math.min(buffer.length * 2, limit + 1));
          buffer.copy(grown, 0, 0, count);
          buffer = grown;
        }
      }
      if (newline + 1 > limit) return null;
      const entry = object(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      if (!entry) return null;
      offset += newline + 1;
      if (harness === "codex") {
        const payload = entry.type === "session_meta" ? object(entry.payload) : null;
        return payload ? { id: payload.id, cwd: payload.cwd } : null;
      }
      if (harness === "claude") {
        if (entry.sessionId && entry.cwd) return { id: entry.sessionId, cwd: entry.cwd };
      } else return entry.type === "session" ? { id: entry.id, cwd: entry.cwd } : null;
    }
    return null;
  } finally { closeSync(fd); }
}

/** A declared managed pane is never allowed to fall through to process/cwd/recency guesses. */
export async function resolveManagedSession(pane: HerdrPane, namespace = managedNamespace(), deps: ManagedSessionDeps = {}): Promise<ManagedSessionResolution | null> {
  const tokens = pane.tokens ?? {};
  if (!("hm_managed_session" in tokens) && !("hm_managed_generation" in tokens)) return null;
  const identity: ManagedSessionIdentity = { id: null, harness: null, generation: null, state: "blocked", reason: null, session_id: null };
  const blocked = (reason: string): ManagedSessionResolution => ({ identity: { ...identity, state: "blocked", reason }, sessionFile: null });
  const pending = (reason: string): ManagedSessionResolution => ({ identity: { ...identity, state: "identity_pending", reason }, sessionFile: null });
  const nonce = tokens.hm_managed_session;
  const generation = tokens.hm_managed_generation;
  if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return blocked("blocked_managed_token");
  identity.id = nonce;
  if (typeof generation !== "string" || !/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) return blocked("blocked_managed_generation");
  identity.generation = Number(generation);
  try {
    const rootInfo = lstatSync(namespace);
    if (!rootInfo.isDirectory() || !owned(rootInfo) || realpathSync(namespace) !== namespace) return blocked("blocked_record_root");
    const path = join(namespace, `${nonce}.json`);
    const { record, unsafe } = recordAt(path);
    if (unsafe) return blocked("blocked_record_owner");
    if (!record || record.nonce !== nonce) return blocked("blocked_record_identity");
    if (record.generation !== identity.generation) return blocked("blocked_managed_generation");
    if (typeof record.harness !== "string" || !HARNESSES.has(record.harness) || record.launcher_harness !== record.harness) return blocked("blocked_record_harness");
    if (!pane.cwd || record.cwd !== realpathSync(pane.cwd) || record.pane_id !== pane.pane_id || record.workspace_id !== pane.workspace_id || !pane.terminal_id || record.terminal_id !== pane.terminal_id) return blocked("blocked_pane_identity");
    // Schema is Manager's recovery protocol, not authority to read a live GJC session.
    identity.harness = record.harness as Harness;
    if (record.desired_state !== "running") return blocked("blocked_session_stopped");
    if (record.state === "blocked") return blocked(typeof record.error === "string" && REASON.test(record.error) ? record.error : "blocked_record_state");
    if (["intent", "registered", "starting", "identity_pending"].includes(String(record.state))) {
      return pending(typeof record.error === "string" && REASON.test(record.error) ? record.error : "identity_pending");
    }
    if (record.state !== "ready") return blocked("blocked_record_state");
    if (typeof record.session_id !== "string" || !ID.test(record.session_id) || typeof record.session_file !== "string" || !isAbsolute(record.session_file)) return blocked("blocked_session_identity");
    const hasFileIdentity = Object.hasOwn(record, "file_identity");
    if (identity.harness === "omo" && !hasFileIdentity) return pending("identity_pending");
    const pinned = hasFileIdentity ? fileIdentityPin(record.file_identity) : null;
    if (hasFileIdentity && !pinned) return blocked("blocked_session_replaced");
    const sessionFile = record.session_file;
    const env = object(record.env) ?? {};
    let store: string;
    if (identity.harness === "gjc" || identity.harness === "omo") {
      store = join(namespace, `${nonce}.sessions`);
      if (record.session_dir !== store) return blocked("blocked_session_root");
    } else {
      const base = identity.harness === "codex" ? env.CODEX_HOME ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex") : env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
      if (typeof base !== "string" || !isAbsolute(base)) return blocked("blocked_session_root");
      store = join(base, identity.harness === "codex" ? "sessions" : "projects");
    }
    const storeInfo = lstatSync(store);
    if (!storeInfo.isDirectory() || !owned(storeInfo) || realpathSync(store) !== store || realpathSync(sessionFile) !== sessionFile || !inside(store, sessionFile) || !sessionFile.endsWith(".jsonl")) return blocked("blocked_session_root");
    const info = lstatSync(sessionFile);
    const pinMatches = pinned ? pinned.dev === info.dev && pinned.ino === info.ino : identity.harness === "gjc";
    if (!info.isFile() || !pinMatches) return blocked("blocked_session_replaced");
    const initialPermission = transcriptPermission(info, identity.harness, pinned !== null && pinMatches, storeInfo);
    if (!initialPermission) return blocked("blocked_session_replaced");
    const meta = header(sessionFile, identity.harness);
    if (!meta || meta.id !== record.session_id || typeof meta.cwd !== "string" || !isAbsolute(meta.cwd) || realpathSync(meta.cwd) !== record.cwd) return blocked("blocked_session_header");
    if (identity.harness === "gjc") {
      const child = object(record.child);
      const readIdentity = deps.processIdentity ?? processIdentity;
      const before = child && typeof child.pid === "number" ? readIdentity(child.pid) : null;
      if (!before || before.starttime !== child!.starttime || before.boot !== child!.boot || before.cwd !== record.cwd) return blocked("blocked_runtime_identity");
      const live = await (deps.gjcSession ?? gjcSdkCurrentSession)([before.pid], record.cwd as string, join(homedir(), ".gjc", "agent"));
      const after = readIdentity(before.pid);
      if (!after || after.pid !== before.pid || after.starttime !== before.starttime || after.boot !== before.boot || after.cwd !== before.cwd) return blocked("blocked_runtime_identity");
      const recordAfter = recordAt(path);
      if (recordAfter.unsafe || bindingKey(recordAfter.record) !== bindingKey(record)) return pending("identity_pending");
      if (!live) return pending("identity_pending");
      if (live.pid !== before.pid || live.hostIncarnation !== `linux:${before.starttime}` || live.sessionId !== record.session_id) return blocked("blocked_gjc_session_mismatch");
    }
    // Detect replacement during header validation as well as between polls.
    const after = lstatSync(sessionFile);
    const finalStoreCheck = initialPermission === "omo-private-store"
      || (identity.harness === "omo" && !owned(after) && (after.mode & 0o020) !== 0);
    const finalStoreInfo = finalStoreCheck ? lstatSync(store) : storeInfo;
    const finalPinMatches = pinned !== null && pinned.dev === after.dev && pinned.ino === after.ino;
    const finalPermission = transcriptPermission(after, identity.harness, finalPinMatches, finalStoreInfo);
    if (!after.isFile() || !finalPermission || ((initialPermission === "omo-private-store" || finalPermission === "omo-private-store")
      && (!privateStore(finalStoreInfo) || realpathSync(store) !== store))
      || realpathSync(sessionFile) !== sessionFile || after.dev !== info.dev || after.ino !== info.ino) return blocked("blocked_session_replaced");
    const currentMeta = header(sessionFile, identity.harness);
    if (!currentMeta || currentMeta.id !== record.session_id || typeof currentMeta.cwd !== "string" || !isAbsolute(currentMeta.cwd) || realpathSync(currentMeta.cwd) !== record.cwd) return blocked("blocked_session_header");
    identity.state = "ready";
    identity.session_id = record.session_id;
    return { identity, sessionFile };
  } catch {
    return blocked("blocked_managed_record_unavailable");
  }
}

/** Preserve engine status: a ready identity is not proof of idle, working or done. */
export async function labelManagedPanes(snapshot: SessionSnapshot, namespace = managedNamespace(), deps: ManagedSessionDeps = {}): Promise<SessionSnapshot> {
  const identities = new Map<string, ManagedSessionIdentity>();
  const panes = await Promise.all(snapshot.panes.map(async pane => {
    const managed = await resolveManagedSession(pane, namespace, deps);
    if (!managed) return pane;
    const identity = managed.identity;
    identities.set(pane.pane_id, identity);
    return { ...pane, agent: identity.harness, agent_session: identity.state === "ready" ? { agent: identity.harness!, kind: "id", source: "herdr-manager", value: identity.session_id! } : null, managed_session: identity };
  }));
  if (identities.size === 0) return snapshot;
  return {
    ...snapshot,
    panes,
    agents: snapshot.agents.map(agent => {
      const identity = identities.get(agent.pane_id);
      return identity ? { ...agent, agent: identity.harness, agent_session: identity.state === "ready" ? { agent: identity.harness!, kind: "id", source: "herdr-manager", value: identity.session_id! } : null } : agent;
    }),
  };
}
