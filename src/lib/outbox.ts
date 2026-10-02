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

/** Does a user turn the transcript gained since the message went out hold it? */
export function recorded(text: string, newUserTexts: readonly string[]): boolean {
  const mine = normalize(text);
  if (mine === "") return true;
  return newUserTexts.some((turn) => {
    const theirs = normalize(turn);
    return theirs !== "" && (theirs.startsWith(mine.slice(0, 200)) || mine.startsWith(theirs.slice(0, 200)));
  });
}
