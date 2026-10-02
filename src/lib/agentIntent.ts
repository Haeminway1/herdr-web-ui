/**
 * OmO opens an answer with how it read the request before the answer itself:
 *   "I read this as an availability check - I'll reply with pong. I'll stop when the message is sent."
 * and, on longer work, a status quote ("> Ask: … For you: … Now: … Next: …"). Both are the agent's
 * bookkeeping, not the answer: the chat shows them as a quiet line above it, and copies leave them out.
 */

const INTENT = /^(?:>\s*)?I read this as\b/i;
const STATUS = /^(?:>\s*)?Ask:\s[\s\S]*\b(?:Now|Next):/;

export interface AnswerIntent {
  /** the lead paragraphs, each on one line with its quote marks gone */
  intent: string[];
  answer: string;
}

export function splitIntent(text: string): AnswerIntent {
  const paragraphs = text.split(/\n\s*\n/);
  const intent: string[] = [];
  while (paragraphs.length > 1 && (INTENT.test(paragraphs[0]!.trimStart()) || (intent.length > 0 && STATUS.test(paragraphs[0]!.trimStart())))) {
    intent.push(paragraphs.shift()!.split("\n").map((line) => line.replace(/^\s*>\s?/, "")).join(" ").replace(/\s+/g, " ").trim());
  }
  return { intent, answer: intent.length > 0 ? paragraphs.join("\n\n") : text };
}
