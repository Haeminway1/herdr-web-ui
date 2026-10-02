import { constants, fstatSync, closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";

const OMO_PROCESS = /(^|\/)omo(\.js)?$|\/omo-ai\//;
/** node and bun run a script: the program is then the script, the first word that is not a flag */
const JS_RUNTIME = /(^|\/)(node|nodejs|bun)$/;
/** omo's engine, run by its launcher; it is omo only with omo-ai's plugin as an extension */
const SENPI_ENTRY = /\/@code-yeongyu\/senpi\/dist\/(bundle\/)?cli\.js$/;
const OMO_EXTENSION = /\/omo-ai\/plugin\/?$/;
/**
 * Only the program counts: argv[0] (omo's native binary, its SDK's claude), or the script a
 * JS runtime runs (`bun …/omo-ai/…/cli.js`, `node …/bin/omo`). An omo-ai path handed to another
 * program (`grep -q …/omo-ai/x`, `cat …/bin/omo`) is that program's argument, not omo. The word
 * is one path: a PATH list that names omo-ai's bin directory (`printf %s\n $PATH` in an rc
 * file) made a fresh shell pass for omo for a moment.
 *
 * A global bun install hoists omo's engine next to omo-ai instead of inside it
 * (`bun …/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js --extension …/node_modules/omo-ai/plugin`):
 * the script is then senpi's own entry, and omo-ai shows only as the extension it loads.
 * Words after a `--` are the prompt, not options: senpi loads no extension from them.
 */
export function isOmoProcess(argv: readonly string[]): boolean {
  const runtime = JS_RUNTIME.test(argv[0] ?? "");
  const program = runtime ? argv.slice(1).find((word) => !word.startsWith("-")) : argv[0];
  if (program === undefined || program.includes(":")) return false;
  if (OMO_PROCESS.test(program)) return true;
  if (!runtime || !SENPI_ENTRY.test(program)) return false;
  const prompt = argv.indexOf("--", argv.indexOf(program));
  const options = prompt === -1 ? argv : argv.slice(0, prompt);
  return options.some((word, at) => options[at - 1] === "--extension" && !word.includes(":") && OMO_EXTENSION.test(word));
}

export interface OmoCandidate { path: string; id: string; createdAt: number | null }
export interface OmoRuntime {
  paneId: string;
  startedAt: number | null;
  /** Exact native session evidence, before considering a cwd/time inference. */
  paths: string[];
  ids: string[];
}

/** A session is never selected by mtime: tool activity is not evidence of pane ownership. */
export function selectOmoTranscript(paneId: string, candidates: OmoCandidate[], runtimes: OmoRuntime[], now = Date.now()): string | null {
  const direct = (runtime: OmoRuntime): OmoCandidate[] => candidates.filter((file) => runtime.paths.includes(file.path) || runtime.ids.includes(file.id));
  const target = runtimes.find((runtime) => runtime.paneId === paneId);
  if (!target) return null;
  const exact = direct(target);
  const claimed = new Set(runtimes.filter((runtime) => runtime !== target).flatMap((runtime) => direct(runtime).map((file) => file.path)));
  if (target.paths.length > 0 || target.ids.length > 0) {
    if (exact.length !== 1 || claimed.has(exact[0]!.path)) return null;
    // A launch ID can outlive /new. Without a current descriptor, a later unclaimed
    // session makes that hint ambiguous rather than pinning the old conversation.
    if (!target.paths.includes(exact[0]!.path) && target.startedAt !== null && candidates.some((file) =>
      file.path !== exact[0]!.path && !claimed.has(file.path) && file.createdAt !== null && file.createdAt > target.startedAt! + 1000 && file.createdAt <= now + 1000)) return null;
    return exact[0]!.path;
  }
  // A second process (or an unreadable peer) sharing cwd blocks inference entirely.
  if (runtimes.length !== 1 || target.startedAt === null) return null;
  const fresh = candidates.filter((file) => file.createdAt !== null && file.createdAt >= target.startedAt! - 1000 && file.createdAt <= now + 1000);
  return fresh.length === 1 ? fresh[0]!.path : null;
}

function inStore(path: string, root: string): boolean {
  try {
    const inside = relative(realpathSync(root), path);
    return !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  } catch { return false; }
}

function candidate(path: string, roots: readonly string[], cwd: string): OmoCandidate | null {
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    if (!canonical.endsWith(".jsonl") || !roots.some((root) => inStore(canonical, root))) return null;
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(4096);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const header = JSON.parse(bytes.subarray(0, length).toString("utf8").split("\n")[0]!);
    if (header?.type !== "session" || header.cwd !== cwd || typeof header.id !== "string") return null;
    const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return { path: canonical, id: header.id, createdAt: Number.isFinite(timestamp) ? timestamp : null };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * omo's engine (senpi) keeps its sessions under its agent directory, which the first of
 * these that is set moves, as pi's PI_CODING_AGENT_DIR moves pi's: a launcher that gives
 * each profile its own state (`OMO_CODING_AGENT_DIR=~/.local/state/<profile>/.omo/agent`)
 * writes no session under ~/.omo, so the chat found none there and showed nothing.
 */
const AGENT_DIR_ENV = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
export const defaultOmoAgentDir = (home: string) => join(home, ".omo", "agent");

/** The agent directory of one omo process, from its environment (null when unreadable: the default). */
export function omoAgentDir(environ: readonly string[] | null, home: string, cwd: string): string {
  for (const name of AGENT_DIR_ENV) {
    const entry = environ?.find((word) => word.startsWith(`${name}=`));
    if (entry === undefined) continue;
    // senpi takes the first one set; an empty one leaves its default
    const value = entry.slice(name.length + 1);
    if (!value) break;
    const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
    return resolve(cwd, expanded);
  }
  return defaultOmoAgentDir(home);
}

/** A process's environment as it started, where the system tells it (Linux). */
export function processEnviron(pid: number): string[] | null {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return null; }
}

const sessionDir = (cwd: string, agentDir: string) => join(agentDir, "sessions", `-${cwd.replaceAll("/", "-")}--`);

// A holder's start is floored to the second (as `ps -o lstart`), ours is in clock ticks.
const HOLDER_START_TOLERANCE_MS = 3000;

/**
 * omo keeps no descriptor on its session file, but every process with a session open
 * publishes <session dir>/session-holders/<encoded id>/<pid>.json and removes it on
 * release (/new, /resume, exit). A crashed process leaves its record behind, so one
 * counts only for the live pid it names and, where our start time is readable, only
 * if it started when that pid did: a reused pid starts later.
 */
export function heldSessionIds(dir: string, pid: number, startedAt: number | null): string[] {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return []; }
  const ids: string[] = [];
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid !== pid) continue;
      if (startedAt !== null && !(typeof record.processStartedAtMs === "number" && Math.abs(record.processStartedAtMs - startedAt) <= HOLDER_START_TOLERANCE_MS)) continue;
      ids.push(decodeURIComponent(name));
    } catch { /* this pid holds nothing here, or the record is unreadable */ }
  }
  return ids;
}

/** When the process that holds a session here started, by its own record: where the system does not tell (macOS). */
export function holderStartedAt(dir: string, pid: number): number | null {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return null; }
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid === pid && typeof record.processStartedAtMs === "number") return record.processStartedAtMs;
    } catch { /* this pid holds nothing here */ }
  }
  return null;
}

/** The earliest start known among a pane's OmO processes: a helper that keeps no record of its own (an MCP child) says nothing against the engine's. */
export function earliestStart(starts: readonly (number | null)[]): number | null {
  const known = starts.filter((start): start is number => start !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

/** Bounded, canonical store reads; exact descriptor paths can live outside the cwd slug. */
export function omoCandidates(cwd: string, home: string, exactPaths: string[] = [], agentDirs: readonly string[] = [defaultOmoAgentDir(home)]): OmoCandidate[] {
  const roots = agentDirs.map((agentDir) => join(agentDir, "sessions"));
  const paths = new Set(exactPaths);
  for (const agentDir of new Set(agentDirs)) {
    const dir = sessionDir(cwd, agentDir);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* only explicit evidence may remain */ }
    // Never choose a subset when the directory is too large to inspect safely.
    if (names.length <= 4096) for (const name of names) if (name.endsWith(".jsonl")) paths.add(join(dir, name));
  }
  const found = new Map<string, OmoCandidate>();
  for (const path of paths) {
    const file = candidate(path, roots, cwd);
    if (file) found.set(file.path, file);
  }
  return [...found.values()];
}

function resumedIds(argv: string[]): string[] {
  const result: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const id = word.startsWith("--session-id=") ? word.slice(13) : word === "--session-id" ? argv[at + 1] : undefined;
    if (id && /^[A-Za-z0-9_-]{8,128}$/.test(id)) result.push(id);
  }
  return result;
}

export type ProcessInfo = { process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } } | null;
const processInfo = (paneId: string): Promise<ProcessInfo> => herdrRpc<NonNullable<ProcessInfo>>("pane.process_info", { pane_id: paneId }).catch(() => null);

/**
 * The session each OmO pane of one folder holds, from the processes herdr named for its panes.
 * Same-cwd peers are inspected even when herdr calls omo's SDK child `claude`.
 */
export function omoTranscriptsOfCwd(cwd: string, panes: HerdrPane[], infos: ReadonlyMap<string, ProcessInfo>, home: string, environOf: (pid: number) => readonly string[] | null = processEnviron): Map<string, { path: string | null; startedAt: number | null }> {
  const runtimes: OmoRuntime[] = [];
  // Each process's own store: the default one, and wherever its environment moved it.
  const agentDirs = new Set([defaultOmoAgentDir(home)]);
  const held = new Map<string, string[]>();
  /** for the status only: the choice of session keeps to starts the system itself told */
  const since = new Map<string, number | null>();
  for (const pane of panes.filter((candidate) => candidate.cwd === cwd)) {
    const info = infos.get(pane.pane_id) ?? null;
    if (!info?.process_info?.foreground_processes) { runtimes.push({ paneId: pane.pane_id, startedAt: null, paths: [], ids: [] }); continue; }
    const processes = (info.process_info?.foreground_processes ?? []).filter((process) => isOmoProcess(process.argv ?? []));
    if (processes.length === 0) continue;
    const starts = processes.map((process) => processStartedAt(process.pid));
    const owned = processes.map((process) => omoAgentDir(environOf(process.pid), home, cwd));
    for (const agentDir of owned) agentDirs.add(agentDir);
    const dirs = owned.map((agentDir) => sessionDir(cwd, agentDir));
    const paths: string[] = [];
    const ids: string[] = [];
    const told = processes.map((process, index) => starts[index] ?? holderStartedAt(dirs[index]!, process.pid));
    since.set(pane.pane_id, earliestStart(told));
    held.set(pane.pane_id, processes.flatMap((process, index) => heldSessionIds(dirs[index]!, process.pid, starts[index] ?? null)));
    for (const [index, process] of processes.entries()) {
      ids.push(...resumedIds(process.argv ?? []));
      // Only an open file in the session store is evidence: omo also holds its background
      // tasks' logs (<cwd>/.omo/senpi-task/logs/*.jsonl) open, and one of those pinned the
      // pane to a path no candidate matches, so the chat lost the transcript mid-session.
      let store = join(owned[index]!, "sessions");
      try { store = realpathSync(store); } catch { /* no store yet: no descriptor can be in it */ }
      let descriptors: string[] = [];
      try { descriptors = readdirSync(`/proc/${process.pid}/fd`).slice(0, 1024); } catch { /* unavailable on macOS */ }
      for (const descriptor of descriptors) {
        try {
          const path = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
          if (path.endsWith(".jsonl") && path.startsWith(store + sep)) paths.push(path);
        } catch { /* descriptor closed */ }
      }
    }
    const session = pane.agent_session;
    if (session?.agent === "omo" && session.value) {
      if (session.kind === "path") paths.push(session.value);
      if (session.kind === "id") ids.push(session.value);
    }
    runtimes.push({ paneId: pane.pane_id, startedAt: starts.every((start) => start !== null) ? Math.min(...(starts as number[])) : null, paths, ids });
  }
  const files = omoCandidates(cwd, home, runtimes.flatMap((runtime) => runtime.paths), [...agentDirs]);
  // Match canonical candidates even when /proc names a symlink into the store.
  for (const runtime of runtimes) runtime.paths = runtime.paths.flatMap((path) => { try { return [realpathSync(path)]; } catch { return []; } });
  for (const runtime of runtimes) {
    const ids = held.get(runtime.paneId) ?? [];
    const current = files.filter((file) => ids.includes(file.id)).map((file) => file.path);
    if (current.length === 0) continue;
    // The session held now outranks a launch --session-id and herdr's session path or id,
    // which /new leaves behind.
    runtime.paths = current;
    runtime.ids = [];
  }
  return new Map(runtimes.map((runtime) => [runtime.paneId, { path: selectOmoTranscript(runtime.paneId, files, runtimes), startedAt: runtime.startedAt ?? since.get(runtime.paneId) ?? null }]));
}

export async function omoTranscriptForPane(paneId: string, cwd: string, panes: HerdrPane[], home = process.env["HOME"] ?? ""): Promise<string | null> {
  const peers = panes.filter((pane) => pane.cwd === cwd);
  const infos = new Map(await Promise.all(peers.map(async (pane) => [pane.pane_id, await processInfo(pane.pane_id)] as const)));
  return omoTranscriptsOfCwd(cwd, peers, infos, home).get(paneId)?.path ?? null;
}

/**
 * Every pane of a snapshot that runs OmO, whatever herdr calls it, with the session it holds
 * (null when that cannot be told) and when its OmO process started. One process lookup per
 * pane herdr has no other agent for, shared by all the panes of a folder.
 */
export async function omoPanes(panes: HerdrPane[], home = process.env["HOME"] ?? ""): Promise<Map<string, { path: string | null; startedAt: number | null }>> {
  const candidates = panes.filter((pane) => !pane.agent || pane.agent === "pi" || pane.agent === "claude" || pane.agent === "omo");
  const infos = new Map(await Promise.all(candidates.map(async (pane) => [pane.pane_id, await processInfo(pane.pane_id)] as const)));
  const runs = (paneId: string) => (infos.get(paneId)?.process_info?.foreground_processes ?? []).some((process) => isOmoProcess(process.argv ?? []));
  const found = new Map<string, { path: string | null; startedAt: number | null }>();
  for (const cwd of new Set(candidates.filter((pane) => runs(pane.pane_id)).map((pane) => pane.cwd ?? ""))) {
    const peers = candidates.filter((pane) => (pane.cwd ?? "") === cwd);
    const transcripts = cwd ? omoTranscriptsOfCwd(cwd, peers, infos, home) : new Map<string, { path: string | null; startedAt: number | null }>();
    for (const pane of peers) if (runs(pane.pane_id)) found.set(pane.pane_id, transcripts.get(pane.pane_id) ?? { path: null, startedAt: null });
  }
  return found;
}
