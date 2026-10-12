/**
 * The status of a GJC pane, read from gjc's own transcript.
 *
 * herdr follows the pane's provider child, not the gjc parent: a turn gjc finished keeps
 * reading `working` for what the child does, and the sidebar holds RUN with no done alert.
 * The transcript the pane's gjc process holds (gjc-runtime.ts finds exactly that file, never a
 * newest file by cwd) tells the parent turn instead: a user prompt, a tool result or an
 * assistant message that stopped for a tool means work; one that stopped for good (`stop`,
 * `length`) is rest, and one that errored or was aborted is rest after a failure — READY, not
 * DONE (#687's rule holds here too). gjc wakes the agent with an `async-result` custom message
 * when a background job ends, displayed or not: that begins a new parent turn. Everything else
 * gjc writes (custom bookkeeping, model notices) is no turn's business.
 *
 * The status replaces herdr's for the pane only once a turn record was actually read: an empty
 * or unreadable transcript proves nothing, so herdr's `working` stands rather than a rest no
 * one saw. The machinery is omo-status.ts's, composed with the `gjc` identity and this file's
 * reducer; gjc keeps no background-task records to count.
 */
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { gjcTranscriptForPane, isGjcProcess } from "./gjc-runtime.ts";
import { processStartedAt } from "./process-start.ts";
import { OmoStatus, type OmoLine, type OmoPane, type OmoStatusDeps, type OmoTurn } from "./omo-status.ts";

/** gjc wakes the parent turn for a finished background job with this custom message */
const ASYNC_RESULT = "async-result";

/**
 * One transcript record applied to the parent turn so far, from a whole line or a projected
 * record's complete JSON (never its text: a record too long to hold says nothing). An
 * assistant message without a readable stopReason keeps the turn as it was.
 */
export function gjcTurnAfter(turn: OmoTurn, line: OmoLine): OmoTurn {
  const text = "text" in line ? line.text : line.record;
  if (text === undefined) return turn;
  let entry: { type?: unknown; customType?: unknown; timestamp?: unknown; message?: { role?: unknown; stopReason?: unknown } };
  try { entry = JSON.parse(text); } catch { return turn; }
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : turn.at;
  if (entry.type === "custom_message") {
    return entry.customType === ASYNC_RESULT ? { status: "working", at, asks: turn.asks } : turn;
  }
  if (entry.type !== "message") return turn;
  const role = entry.message?.role;
  const stopReason = entry.message?.stopReason;
  if (role === "user" || role === "toolResult") return { status: "working", at, asks: turn.asks };
  if (role !== "assistant") return turn;
  if (stopReason === "toolUse") return { status: "working", at, asks: turn.asks };
  if (stopReason === "stop" || stopReason === "length") return { status: "idle", at, asks: turn.asks };
  if (stopReason === "error" || stopReason === "aborted") return { status: "idle", failed: true, at, asks: turn.asks };
  return turn;
}

type ProcessInfo = { process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown }[] } } | null;

/**
 * The panes of a snapshot herdr labels `gjc`, with the exact transcript each holds (null when
 * it cannot be told: herdr's status stands for the pane) and when its native foreground gjc
 * process started, so a turn a resumed session left unfinished is not taken for running work.
 * `agent_session` is never consulted: it may name the provider child, not the gjc parent.
 */
export async function gjcPanes(panes: HerdrPane[]): Promise<Map<string, OmoPane>> {
  const found = new Map<string, OmoPane>();
  await Promise.all(panes.filter((pane) => pane.agent === "gjc").map(async (pane) => {
    const info = await herdrRpc<NonNullable<ProcessInfo>>("pane.process_info", { pane_id: pane.pane_id }).catch(() => null);
    const starts = (info?.process_info?.foreground_processes ?? [])
      .filter((process) => typeof process.pid === "number" && Array.isArray(process.argv) && isGjcProcess(process.argv.map(String)))
      .map((process) => processStartedAt(process.pid as number))
      .filter((start): start is number => start !== null);
    const path = await gjcTranscriptForPane(pane.pane_id, pane.cwd ?? "").catch(() => null);
    found.set(pane.pane_id, { path, startedAt: starts.length > 0 ? Math.min(...starts) : null });
  }));
  return found;
}

/**
 * The tracker's GJC composition: the `gjc` identity (herdr gives it no other name, so no
 * aliases), this file's reducer, no background counts, and the readiness gate that releases a
 * transcript nothing was read from back to herdr's status.
 */
export function createGjcStatus(deps: Omit<OmoStatusDeps, "agent" | "aliases" | "turnAfter" | "ready" | "background">): OmoStatus {
  return new OmoStatus({
    ...deps,
    agent: "gjc",
    aliases: [],
    turnAfter: gjcTurnAfter,
    ready: ({ turn }) => turn.status !== null,
    background: () => new Map(),
  });
}
