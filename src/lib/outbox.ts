/**
 * Messages the composer sent that the transcript does not hold yet. The chat shows each one at
 * once, as sending and then sent, until the agent's conversation records it (ChatView), so a send
 * reads as done the moment it is made, not when the agent's file catches up.
 */
export interface Outgoing {
  id: number;
  pane: string;
  text: string;
  /** the pane took it */
  sent: boolean;
  at: number;
}

/** how long a sent message stays shown when the transcript never records it (a shell, an agent without one) */
export const OUTGOING_KEEP_MS = 20_000;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Is this user turn that message? The same text, spaces aside. */
export function sameMessage(sent: string, turn: string): boolean {
  return normalize(sent) === normalize(turn);
}

export interface UserTurn {
  /** the same for the same turn whichever page holds it */
  key: string;
  text: string;
}

/**
 * Which of the messages on their way the transcript holds now. `seen` is the user turns there
 * already when the message went out, by key, so a page that moves keeps them apart; each new
 * user turn stands for one message only, the oldest message first, so "yes" sent twice is
 * recorded twice before both go.
 */
export function recordedIds(items: ReadonlyArray<{ id: number; text: string; seen: ReadonlySet<string> }>, turns: readonly UserTurn[]): Set<number> {
  const used = new Set<string>();
  const done = new Set<number>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    if (normalize(item.text) === "") { done.add(item.id); continue; }
    const turn = turns.find((candidate) => !item.seen.has(candidate.key) && !used.has(candidate.key) && sameMessage(item.text, candidate.text));
    if (!turn) continue;
    used.add(turn.key);
    done.add(item.id);
  }
  return done;
}
