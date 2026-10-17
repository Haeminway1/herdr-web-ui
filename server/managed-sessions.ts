/** Read-only projection of Herdr Manager's schema-2 ownership records. No discovery or writes. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { HerdrPane, ManagedSessionIdentity, SessionSnapshot } from "../shared/protocol.ts";

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

/** Read at most 16 KiB per identity row, never transcript messages beyond Claude's header prefix. */
function header(path: string, harness: Harness): { id: unknown; cwd: unknown } | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(16385);
    let offset = 0;
    for (let row = 0; row < (harness === "claude" ? 32 : 1); row++) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      const newline = buffer.subarray(0, count).indexOf(10);
      if (count === 0 || newline < 0) return null;
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
export function resolveManagedSession(pane: HerdrPane, namespace = managedNamespace()): ManagedSessionResolution | null {
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
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let record: Record<string, unknown> | null;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || !owned(info) || info.size > 65536) return blocked("blocked_record_owner");
      const buffer = Buffer.alloc(65537);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 65536) return blocked("blocked_record_owner");
      record = object(JSON.parse(buffer.subarray(0, count).toString("utf8")));
    } finally { closeSync(fd); }
    if (!record || record.nonce !== nonce) return blocked("blocked_record_identity");
    if (record.generation !== identity.generation) return blocked("blocked_managed_generation");
    if (typeof record.harness !== "string" || !HARNESSES.has(record.harness) || record.launcher_harness !== record.harness) return blocked("blocked_record_harness");
    if (!pane.cwd || record.cwd !== realpathSync(pane.cwd) || record.pane_id !== pane.pane_id || record.workspace_id !== pane.workspace_id || !pane.terminal_id || record.terminal_id !== pane.terminal_id) return blocked("blocked_pane_identity");
    // A bound but obsolete record can explain the badge, never authorize a transcript.
    identity.harness = record.harness as Harness;
    if (record.schema !== 2) return blocked("blocked_record_schema");
    if (record.desired_state !== "running") return blocked("blocked_session_stopped");
    if (record.state === "blocked") return blocked(typeof record.error === "string" && REASON.test(record.error) ? record.error : "blocked_record_state");
    if (["intent", "registered", "starting", "identity_pending"].includes(String(record.state))) {
      return pending(typeof record.error === "string" && REASON.test(record.error) ? record.error : "identity_pending");
    }
    if (record.state !== "ready") return blocked("blocked_record_state");
    if (typeof record.session_id !== "string" || !ID.test(record.session_id) || typeof record.session_file !== "string" || !isAbsolute(record.session_file)) return blocked("blocked_session_identity");
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
    const pinned = object(record.file_identity);
    if (!info.isFile() || !owned(info) || !pinned || pinned.dev !== info.dev || pinned.ino !== info.ino) return blocked("blocked_session_replaced");
    const meta = header(sessionFile, identity.harness);
    if (!meta || meta.id !== record.session_id || typeof meta.cwd !== "string" || !isAbsolute(meta.cwd) || realpathSync(meta.cwd) !== record.cwd) return blocked("blocked_session_header");
    // Detect replacement during header validation as well as between polls.
    const after = statSync(sessionFile);
    if (after.dev !== info.dev || after.ino !== info.ino) return blocked("blocked_session_replaced");
    identity.state = "ready";
    identity.session_id = record.session_id;
    return { identity, sessionFile };
  } catch {
    return blocked("blocked_managed_record_unavailable");
  }
}

/** Preserve engine status: a ready identity is not proof of idle, working or done. */
export function labelManagedPanes(snapshot: SessionSnapshot, namespace = managedNamespace()): SessionSnapshot {
  const identities = new Map<string, ManagedSessionIdentity>();
  const panes = snapshot.panes.map(pane => {
    const managed = resolveManagedSession(pane, namespace);
    if (!managed) return pane;
    const identity = managed.identity;
    identities.set(pane.pane_id, identity);
    return { ...pane, agent: identity.harness, agent_session: identity.state === "ready" ? { agent: identity.harness!, kind: "id", source: "herdr-manager", value: identity.session_id! } : null, managed_session: identity };
  });
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
