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
/** a message this long may come back cut or with more after it: its first part is enough */
const LONG = 200;

/** Is this user turn that message? The same text, spaces aside; a long one by its first part. */
export function sameMessage(sent: string, turn: string): boolean {
  const mine = normalize(sent);
  const theirs = normalize(turn);
  if (mine === theirs) return true;
  return mine.length >= LONG && theirs.length >= LONG && mine.slice(0, LONG) === theirs.slice(0, LONG);
}

/**
 * Which of the messages on their way the transcript holds now. `baseline` is how many user turns
 * the newest page had when the message went out; each newer user turn stands for one message
 * only, the oldest message first, so "yes" sent twice is recorded twice before both go.
 */
export function recordedIds(items: ReadonlyArray<{ id: number; text: string; baseline: number }>, userTexts: readonly string[]): Set<number> {
  const used = new Set<number>();
  const done = new Set<number>();
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    if (normalize(item.text) === "") { done.add(item.id); continue; }
    for (let index = item.baseline; index < userTexts.length; index++) {
      if (used.has(index) || !sameMessage(item.text, userTexts[index]!)) continue;
      used.add(index);
      done.add(item.id);
      break;
    }
  }
  return done;
}
