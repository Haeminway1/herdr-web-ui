import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { turnSkills } from "./skillActivity.ts";
import { isTodoTool } from "./todos.ts";
import { t } from "./i18n.ts";

export type ToolPart = Extract<ConversationPart, { kind: "tool" }>;
export type ThinkingPart = Extract<ConversationPart, { kind: "thinking" }>;
export type TextPart = Extract<ConversationPart, { kind: "text" }>;

/**
 * A turn the way Codex shows it: everything the agent did on the way — tool calls,
 * reasoning and the narration between them — folded under one "Worked for 7s · 1 edit"
 * header, and only what it said after the last action left out in the open as the answer.
 */
export interface SplitTurn {
  work: ConversationPart[];
  answer: TextPart[];
}

export function splitTurn(parts: ConversationPart[]): SplitTurn {
  let lastAction = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part?.kind !== "text" || part.phase === "commentary") lastAction = index;
  }
  const isProse = (part: ConversationPart): part is TextPart => part.kind === "text" && part.text.trim().length > 0;
  return {
    work: parts.filter((part, index) => part.kind !== "text" || (isProse(part) && part.phase !== "final_answer" && index <= lastAction)),
    answer: parts.filter((part, index): part is TextPart => isProse(part) && (part.phase === "final_answer" || index > lastAction)),
  };
}

type WorkCategory = "edit" | "read" | "command" | "other";

/** "{n} edit" / "{n} edits": both forms are translated, Korean uses one */
export const CATEGORY_LABEL: Record<WorkCategory, [singular: string, plural: string]> = {
  edit: ["{n} edit", "{n} edits"],
  read: ["{n} file read", "{n} file reads"],
  command: ["{n} command", "{n} commands"],
  other: ["{n} other tool", "{n} other tools"],
};

function categorize(name: string): WorkCategory {
  const lower = name.toLowerCase();
  if (/edit|write|patch|create_file|multiedit/.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/.test(lower)) return "command";
  return "other";
}

/** "1 edit · 2 file reads · 1 command" — the block's header, in the order a reader cares about. */
export function workSummary(parts: readonly ConversationPart[]): string {
  const counts: Record<WorkCategory, number> = { edit: 0, read: 0, command: 0, other: 0 };
  let failed = 0;
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    // a todo update is the plan, pinned under the chat, not an edit: TodoWrite would match /write/
    if (!part.skill && !isTodoTool(part.name)) counts[categorize(part.name)] += 1;
    if (part.error) failed += 1;
  }
  // a failure says so in the folded header: it is what a glance at a finished turn must not miss
  const skills = turnSkills(parts).length;
  return [...(skills > 0 ? [t(skills === 1 ? "{n} skill" : "{n} skills", { n: skills })] : []), ...(Object.keys(counts) as WorkCategory[])
    .filter((category) => counts[category] > 0)
    .map((category) => t(CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1], { n: counts[category] })),
    ...(failed > 0 ? [t("{n} failed", { n: failed })] : [])]
    .join(" · ");
}

/** "7s" / "1m 12s" for a block header; null when the span is unknown or nonsense. */
export function formatWorkDuration(startTs: string | null, endTs: string | null): string | null {
  if (startTs === null || endTs === null) return null;
  const ms = Date.parse(endTs) - Date.parse(startTs);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t("{s}s", { s: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? t("{m}m {s}s", { m: minutes, s: rest }) : t("{m}m", { m: minutes });
  return t("{h}h {m}m", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/**
 * end_ts is the latest activity time, not proof that an approval-blocked turn finished.
 *
 * `sentOver` is the assistant turn that was last when a message was sent. The pushed status turns
 * `working` before the transcript holds the new user message, so until it does, that finished turn
 * is still the last one and must not be titled as if it were the one running. The turn itself, not
 * its time: a turn may have no `ts`, and the browser's clock and the transcript's need not agree.
 */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, status?: string, sentOver?: ConversationTurn | null): boolean {
  if (turn === sentOver) return false;
  return last && turn.role === "assistant" && (status === "working" || status === "blocked");
}

/** What a running turn is doing now, for the line over the message box (Composer.tsx). */
export interface WorkNow {
  /** when the turn began (its user message, else its own first record), ms; null when unknown */
  since: number | null;
  /** its latest tool call, said shortly: "Running git status", "Editing src/app.ts" */
  doing: string | null;
}

// each said in full here, so the dictionaries' check finds every one of them
const DOING: Record<WorkCategory, (what: string) => string> = {
  edit: (what) => t("Editing {what}", { what }),
  read: (what) => t("Reading {what}", { what }),
  command: (what) => t("Running {what}", { what }),
  other: (what) => t("Using {what}", { what }),
};

function shortly(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The running turn's start and latest tool, or null when the last turn is not running. */
export function workNow(turns: readonly ConversationTurn[], live: boolean): WorkNow | null {
  const last = turns.at(-1);
  if (!live || !last) return null;
  // its own start unless its user message says earlier: an assistant turn before it with no user
  // message between (a Codex task_started run, a page cut mid-run) belongs to an older run
  const lastAt = last.ts ? Date.parse(last.ts) : Number.NaN;
  let since: number | null = Number.isFinite(lastAt) ? lastAt : null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role !== "user") continue;
    const at = turn.ts ? Date.parse(turn.ts) : Number.NaN;
    if (Number.isFinite(at)) since = at;
    break;
  }
  const tool = [...last.parts].reverse().find((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool" && !isTodoTool(part.name));
  const what = tool ? shortly(tool.summary || tool.name) : null;
  return { since, doing: tool && what ? DOING[categorize(tool.name)](what) : null };
}

/** "45s", "3m 12s", "1h 4m" from `since` to `now`. */
export function formatElapsed(since: number, now: number): string | null {
  return formatWorkDuration(new Date(since).toISOString(), new Date(Math.max(now, since)).toISOString());
}
