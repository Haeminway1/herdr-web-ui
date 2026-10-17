import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentStatus, ConversationTurn, HerdrPane, PaneAttention, SessionSnapshot } from "../shared/protocol.ts";
import { herdrSocketId } from "./completion.ts";

/** records kept at most: one per pane, and nobody keeps this many panes open */
const MAX_RECORDS = 500;
const PREVIEW_CHARS = 120;

/**
 * Which panes have an answer nobody has read yet, kept on the server so every device agrees.
 *
 * herdr's own `done` is no "unread": it clears only when the pane is focused at herdr's
 * terminal, which a browser or a phone never does (and must not: that moves the TUI's
 * focus). So a finish is stamped here (`finished_at`), opening the pane in the web UI stamps
 * `seen_at`, and a pane whose finish is newer than its last read is to be read.
 *
 * The statuses measured are the ones clients are shown (after server/completion.ts settled
 * them). Kept in a file for the herdr the panes live in, like the completion tracker's:
 * a herdr started anew reuses pane ids for other panes.
 */
export class AttentionStore {
  private readonly records = new Map<string, PaneAttention & { touched: number }>();
  /** each pane's status as last observed: a finish is measured against it */
  private readonly last = new Map<string, AgentStatus>();
  /** when each status in `last` was learned: a snapshot asked for before it is older */
  private readonly lastAt = new Map<string, number>();
  private saved = "";

  constructor(
    private readonly file: string | null = null,
    private readonly herdr: () => string | null = herdrSocketId,
    private readonly now: () => number = Date.now,
  ) {
    if (file === null) return;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { herdr?: unknown; panes?: unknown };
      const current = herdr();
      if (current === null || state.herdr !== current || !state.panes || typeof state.panes !== "object") return;
      for (const [paneId, value] of Object.entries(state.panes as Record<string, unknown>)) {
        const record = value as Partial<PaneAttention> | null;
        if (!record || typeof record !== "object") continue;
        const text = (field: unknown): string | null => typeof field === "string" ? field : null;
        this.records.set(paneId, { finished_at: text(record.finished_at), seen_at: text(record.seen_at), preview: text(record.preview), touched: 0 });
      }
      this.saved = this.serialize(current);
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /**
   * A status as reported to clients. True when it is a finish: work ending at rest, or herdr's
   * `done` arriving from anything but `done` (a blocked agent that went on and finished).
   */
  observe(paneId: string, status: AgentStatus): boolean {
    const before = this.last.get(paneId);
    this.last.set(paneId, status);
    this.lastAt.set(paneId, this.now());
    const finished = (before === "working" && (status === "done" || status === "idle"))
      || (status === "done" && before !== undefined && before !== "done");
    if (finished) this.finish(paneId);
    return finished;
  }

  /**
   * Every pane in a snapshot clients are shown, asked for at `askedAt`. A pane first seen as
   * `done` with nothing kept for it finished before this server knew it: it counts from now.
   * Records of panes gone before the snapshot was asked for are dropped. Returns the panes
   * that finished here.
   */
  baseline(panes: readonly Pick<HerdrPane, "pane_id" | "agent_status">[], askedAt = this.now()): string[] {
    const live = new Set(panes.map((pane) => pane.pane_id));
    const finished: string[] = [];
    for (const pane of panes) {
      if (this.last.has(pane.pane_id)) {
        // a status event may never come (herdr's stream can miss a pane it learned of late):
        // a snapshot asked for after the last status heard is as good, an older one is not
        if (pane.agent_status !== this.last.get(pane.pane_id) && askedAt > (this.lastAt.get(pane.pane_id) ?? 0)) {
          const before = this.last.get(pane.pane_id);
          this.last.set(pane.pane_id, pane.agent_status);
          this.lastAt.set(pane.pane_id, askedAt);
          if ((before === "working" && (pane.agent_status === "done" || pane.agent_status === "idle")) || (pane.agent_status === "done" && before !== "done")) {
            this.finish(pane.pane_id);
            finished.push(pane.pane_id);
          }
        }
        continue;
      }
      this.last.set(pane.pane_id, pane.agent_status);
      this.lastAt.set(pane.pane_id, askedAt);
      if (pane.agent_status === "done" && !this.records.has(pane.pane_id)) {
        this.finish(pane.pane_id);
        finished.push(pane.pane_id);
      }
    }
    for (const [paneId, record] of this.records) {
      // one touched since the snapshot was asked for may be a pane too new for it
      if (!live.has(paneId) && record.touched < askedAt) this.records.delete(paneId);
    }
    for (const paneId of this.last.keys()) if (!live.has(paneId) && !this.records.has(paneId)) { this.last.delete(paneId); this.lastAt.delete(paneId); }
    this.save();
    return finished;
  }

  /** It finished after it was last read (or never was). */
  unread(paneId: string): boolean {
    const record = this.records.get(paneId);
    return !!record?.finished_at && (record.seen_at === null || Date.parse(record.seen_at) < Date.parse(record.finished_at));
  }

  /** The pane was read in the web UI. Null when it never finished here: there is nothing to read. */
  markSeen(paneId: string): PaneAttention | null {
    const record = this.records.get(paneId);
    if (!record?.finished_at) return null;
    const now = this.now();
    // never before the finish it reads, whatever the clock did
    record.seen_at = new Date(Math.max(now, Date.parse(record.finished_at))).toISOString();
    record.touched = now;
    this.save();
    return this.get(paneId);
  }

  /** The first line of the answer that finished at `finishedAt`; false when the pane finished again since. */
  setPreview(paneId: string, finishedAt: string, preview: string | null): boolean {
    const record = this.records.get(paneId);
    if (!record || record.finished_at !== finishedAt || preview === null || record.preview === preview) return false;
    record.preview = preview;
    this.save();
    return true;
  }

  /** The pane closed or exited. */
  forget(paneId: string): void {
    this.last.delete(paneId);
    if (this.records.delete(paneId)) this.save();
  }

  get(paneId: string): PaneAttention | null {
    const record = this.records.get(paneId);
    return record ? { finished_at: record.finished_at, seen_at: record.seen_at, preview: record.preview } : null;
  }

  /** The snapshot with each pane's read state in it. */
  decorate(snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot.panes.some((pane) => this.records.has(pane.pane_id))) return snapshot;
    return { ...snapshot, panes: snapshot.panes.map((pane) => {
      const attention = this.get(pane.pane_id);
      return attention ? { ...pane, attention } : pane;
    }) };
  }

  private finish(paneId: string): void {
    const now = this.now();
    // a new finish: the old answer's preview is not this one's
    this.records.set(paneId, { finished_at: new Date(now).toISOString(), seen_at: this.records.get(paneId)?.seen_at ?? null, preview: null, touched: now });
    if (this.records.size > MAX_RECORDS) {
      const oldest = [...this.records].sort(([, a], [, b]) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""));
      for (const [id] of oldest.slice(0, this.records.size - MAX_RECORDS)) this.records.delete(id);
    }
    this.save();
  }

  private serialize(herdr: string): string {
    const panes = Object.fromEntries([...this.records.keys()].sort().map((id) => [id, this.get(id)]));
    return JSON.stringify({ herdr, panes });
  }

  /** Written whole, and only on a change: a crash mid-write must not leave half a file. */
  private save(): void {
    if (this.file === null) return;
    const herdr = this.herdr();
    if (herdr === null) return;
    const state = this.serialize(herdr);
    if (state === this.saved) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, state, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.saved = state;
    } catch (error) {
      // a full disk costs the read state after a restart, never the status itself
      console.error(`attention state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The first line of the last answer, for the To read row: the final answer when the agent
 * marks one, else the last text it wrote. Markdown's line marks go; null when there is none.
 */
export function answerPreview(turns: readonly ConversationTurn[]): string | null {
  const answer = [...turns].reverse().find((turn) => turn.role === "assistant" && turn.parts.some((part) => part.kind === "text" && part.text.trim() !== ""));
  if (!answer) return null;
  const texts = answer.parts.flatMap((part) => part.kind === "text" && part.text.trim() !== "" ? [part] : []);
  const text = ([...texts].reverse().find((part) => part.phase === "final_answer") ?? texts.at(-1))!.text;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|```\w*)/, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
    if (line === "") continue;
    return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
  }
  return null;
}
