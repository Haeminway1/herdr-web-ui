import { lstatSync } from "node:fs";
import { join } from "node:path";

import { GJC_NATIVE_DIRECTORY } from "../shared/gjc-native.ts";
import { readGjcNativeBinding, validateGjcNativeTranscript } from "./gjc-native.ts";
import { lookupExecutionError } from "./gjc-sdk-error.ts";
import { forgetGjcPane as forgetSdkPane, forgetGjcState as forgetSdkState, gjcPidUnderShell, gjcTranscriptForPane as sdkTranscriptForPane, isGjcProcess, recentProcessTable } from "./gjc-runtime.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";
import { windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

type ProcessInfo = { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } };
type ProcessIdentity = { pid: number; birth: number };
type Options = {
  platform?: string;
  processInfo?: (paneId: string) => Promise<ProcessInfo | null>;
  processBirth?: (pid: number) => number | null;
  readProcessTable?: () => Promise<ProcessRow[]>;
  now?: () => number;
};
type Token = { cancelled: boolean };
const lookups = new Map<string, Set<Token>>();
// Once a process publishes native authority, losing its record cannot downgrade it to SDK discovery.
const nativeOwners = new Map<string, ProcessIdentity>();
let freshReads = 0;
let freshTable: { read: () => Promise<ProcessRow[]>; started: number; rows: Promise<ProcessRow[]> } | null = null;

function freshProcessTable(read: () => Promise<ProcessRow[]>, after: number): Promise<ProcessRow[]> {
  if (freshTable && freshTable.read === read && freshTable.started > after) return freshTable.rows;
  const entry = { read, started: ++freshReads, rows: Promise.resolve().then(read) };
  freshTable = entry;
  const clear = () => { if (freshTable === entry) freshTable = null; };
  void entry.rows.then(clear, clear);
  return entry.rows;
}

export function forgetGjcPane(paneId: string): void {
  for (const token of lookups.get(paneId) ?? []) token.cancelled = true;
  lookups.delete(paneId);
  nativeOwners.delete(paneId);
  forgetSdkPane(paneId);
}

export function forgetGjcState(): void {
  for (const tokens of lookups.values()) for (const token of tokens) token.cancelled = true;
  lookups.clear();
  nativeOwners.clear();
  freshTable = null;
  forgetSdkState();
}

function sameBirth(left: number, right: number, platform: string): boolean {
  return platform === "darwin" ? Math.abs(left - right) <= 1000 : left === right;
}

async function foregroundProcesses(info: ProcessInfo | null, platform: string, options: Options, fresh: boolean, freshAfter = -1): Promise<ProcessIdentity[] | null> {
  const processInfo = info?.process_info;
  if (!processInfo) return null;
  if (platform === "win32") {
    const read = options.readProcessTable ?? windowsProcessTable;
    const table = fresh ? () => freshProcessTable(read, freshAfter) : () => recentProcessTable(read, (options.now ?? Date.now)());
    const process = await gjcPidUnderShell(processInfo.shell_pid, platform, table);
    if (process === undefined) throw lookupExecutionError(undefined);
    if (process === null) return [];
    if (!Number.isSafeInteger(process.started) || process.started === null || process.started <= 0) throw lookupExecutionError(undefined);
    return [{ pid: process.pid, birth: process.started }];
  }
  const foreground = processInfo.foreground_processes;
  if (!Array.isArray(foreground)) return null;
  const identities = new Map<number, number>();
  const birthOf = options.processBirth ?? processStartedAt;
  for (const process of foreground) {
    const argv = Array.isArray(process.argv) ? process.argv.filter((arg): arg is string => typeof arg === "string") : [];
    if (!isGjcProcess(argv)) continue;
    if (typeof process.pid !== "number" || !Number.isSafeInteger(process.pid) || process.pid <= 0) return null;
    const birth = birthOf(process.pid);
    if (birth === null || !Number.isSafeInteger(birth) || birth <= 0) throw lookupExecutionError(undefined);
    const previous = identities.get(process.pid);
    if (previous !== undefined && !sameBirth(previous, birth, platform)) return null;
    identities.set(process.pid, birth);
  }
  return [...identities].map(([pid, birth]) => ({ pid, birth }));
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity, platform: string): boolean {
  return left.pid === right.pid && sameBirth(left.birth, right.birth, platform);
}

function sameNativeVersion(left: NonNullable<ReturnType<typeof readGjcNativeBinding>>, right: NonNullable<ReturnType<typeof readGjcNativeBinding>>): boolean {
  if (left.pid !== right.pid || left.processStartedAt !== right.processStartedAt || left.instanceId !== right.instanceId || left.sequence !== right.sequence) return false;
  if (left.session === null || right.session === null) return left.session === right.session;
  return left.session.id === right.session.id && left.session.path === right.session.path && left.session.cwd === right.session.cwd;
}

/** Native lifecycle authority and SDK authority are selected before reading either transcript. */
export function gjcTranscriptForPane(paneId: string, cwd: string, home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "", options: Options = {}): Promise<string | null> {
  return resolveTranscript(paneId, cwd, home, options, false);
}

/** The lifecycle-only path, also used by isolated native-record fixtures. */
export function gjcNativeTranscriptForPane(paneId: string, cwd: string, home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "", options: Options = {}): Promise<string | null> {
  return resolveTranscript(paneId, cwd, home, options, true);
}

function resolveTranscript(paneId: string, cwd: string, home: string, options: Options, nativeOnly: boolean): Promise<string | null> {
  const token: Token = { cancelled: false };
  const running = lookups.get(paneId) ?? new Set<Token>();
  running.add(token);
  lookups.set(paneId, running);
  return lookupTranscript(paneId, cwd, home, options, nativeOnly, token).catch((error: unknown) => { throw lookupExecutionError(error); }).finally(() => {
    running.delete(token);
    if (running.size === 0 && lookups.get(paneId) === running) lookups.delete(paneId);
  });
}

async function lookupTranscript(paneId: string, cwd: string, home: string, options: Options, nativeOnly: boolean, token: Token): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const readInfo = options.processInfo ?? (async (id: string) => ({ process_info: await paneProcessInfo(id) }));
  const info = await readInfo(paneId);
  if (!info || token.cancelled) return null;
  const initial = await foregroundProcesses(info, platform, options, false);
  if (!initial || initial.length === 0 || token.cancelled) return null;
  const owner = initial[0]!;
  const previous = nativeOwners.get(paneId);
  if (previous && !initial.some((process) => sameProcess(previous, process, platform))) nativeOwners.delete(paneId);
  let native = nativeOnly || nativeOwners.has(paneId);
  for (const process of initial) {
    try {
      lstatSync(join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY, `${process.pid}.json`));
      native = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || nativeOwners.has(paneId)) throw lookupExecutionError(error);
    }
  }
  if (!native) {
    const path = await sdkTranscriptForPane(paneId, cwd, home, options);
    for (const process of initial) {
      try {
        lstatSync(join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY, `${process.pid}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lookupExecutionError(error);
      }
      forgetSdkPane(paneId);
      throw lookupExecutionError(undefined);
    }
    return token.cancelled ? null : path;
  }
  forgetSdkPane(paneId);
  if (initial.length !== 1) return null;
  if (!token.cancelled) nativeOwners.set(paneId, owner);
  const freshAfter = freshReads;
  const binding = readGjcNativeBinding(home, owner.pid, options.now?.());
  if (!binding || !sameBirth(binding.processStartedAt, owner.birth, platform) || !binding.session || token.cancelled) return null;
  const path = validateGjcNativeTranscript(binding, cwd, home, platform);
  if (!path || token.cancelled) return null;
  const finalInfo = await readInfo(paneId);
  if (!finalInfo || token.cancelled) return null;
  const final = await foregroundProcesses(finalInfo, platform, options, true, freshAfter);
  if (!final || final.length !== 1 || !sameProcess(owner, final[0]!, platform) || token.cancelled) return null;
  const current = readGjcNativeBinding(home, owner.pid, options.now?.());
  if (!current || !sameBirth(current.processStartedAt, final[0]!.birth, platform) || !sameNativeVersion(binding, current) || token.cancelled) return null;
  const currentPath = validateGjcNativeTranscript(current, cwd, home, platform);
  return currentPath === path && !token.cancelled ? currentPath : null;
}
