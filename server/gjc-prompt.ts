import type { OmoAsks } from "./omo-ask.ts";

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OTHER = "Other (type your own)";
const CLARIFY = "Ask about these choices";
const compact = (text: string) => text.replace(/\s+/g, "");
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
const rule = (line: string) => /^[─━]{3,}$/.test(line.trimEnd());
const footers = (pages: boolean) => [
  `up/down navigate  enter select${pages ? "  ←/→ question" : ""}  esc cancel`,
  `↑/↓ select  enter${pages ? "  ←/→ question" : ""}  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript`,
];

export interface GjcAskMenu {
  call: string;
  questionIndex: number;
  question: string;
  labels: string[];
  selectedIndex: number;
}

/** Recognize an ask-shaped live dialog even after settlement; never inspect old transcript text. */
export function gjcAskScreen(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!rule(lines.at(-1) ?? "")) return false;
  const borders = lines.flatMap((line, index) => rule(line) ? [index] : []).slice(-3);
  if (borders.length !== 3) return false;
  const [listTop, listBottom, bottom] = borders as [number, number, number];
  const footer = compact(lines.slice(listBottom + 1, bottom).join(""));
  return [false, true].some((pages) => compact(footers(pages)[1]!) === footer)
    || compact(lines.slice(listTop + 1, listBottom).join("")).includes(compact(OTHER));
}

/**
 * Consume physical wraps against the known label, retaining punctuation and case. A wrap
 * may drop whitespace or split a Korean word; no prefix/substring question matching.
 */
function wholeWrapped(rows: string[], expected: string): boolean {
  const text = normalized(expected);
  let offset = 0;
  for (const row of rows) {
    const part = normalized(row);
    if (!part || !text.startsWith(part, offset)) return false;
    offset += part.length;
    if (text[offset] === " ") offset += 1;
  }
  return offset === text.length;
}

/** A sibling is one native row, either whole or truncated at the actual label width. */
function sibling(shown: string, expected: string, width: number): boolean {
  if (shown === expected) return Bun.stringWidth(shown) <= width;
  if (!shown.endsWith("…") || !expected.startsWith(shown.slice(0, -1))) return false;
  const prefix = shown.slice(0, -1);
  const next = [...expected.slice(prefix.length)][0];
  return next !== undefined && Bun.stringWidth(expected) > width
    && Bun.stringWidth(shown) <= width && Bun.stringWidth(prefix + next + "…") > width;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function completeText(value: unknown): value is string {
  // readOmoLines caps a projected JSON string at 64 KiB. Even escaped code units
  // cannot truncate a <=4096-character label into another accepted label here.
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

/**
 * GJC 0.18.12 ask -> HookSelector(outline, wrapFocused). All four borders, the complete
 * title, exact selector footer and every visible option must belong to one open call/page.
 * Continuation-row partitions are tried against that call, not turned into buttons. A
 * viewport marker proves the logical cursor, but never substitutes for matching its label.
 */
export function gjcAskMenu(screen: string, asks: OmoAsks): GjcAskMenu | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  if (!rule(lines.at(-1) ?? "")) return null;
  const borders = lines.flatMap((line, index) => rule(line) ? [index] : []).slice(-4);
  if (borders.length !== 4 || borders[3] !== lines.length - 1) return null;
  const [top, listTop, listBottom, bottom] = borders as [number, number, number, number];
  if (!borders.every((index) => lines[index]!.trimEnd() === lines[bottom]!.trimEnd())) return null;
  const title = lines.slice(top + 1, listTop).map((line) => line.trim()).filter(Boolean);
  const footer = compact(lines.slice(listBottom + 1, bottom).join(""));
  const width = Bun.stringWidth(lines[listTop]!) - 4; // two outline columns + cursor/indent
  if (width < 1) return null;
  const raw = lines.slice(listTop + 1, listBottom);
  if (!raw.length || raw.some((line) => !/^│(?:❯ |  ).*│\s*$/.test(line) || Bun.stringWidth(line.trimEnd()) !== width + 4)) return null;
  const rows = raw.map((line) => line.slice(1, line.lastIndexOf("│")).trimEnd());
  const cursor = rows.findIndex((line) => line.startsWith("❯ "));
  if (cursor < 0 || rows.filter((line) => line.startsWith("❯ ")).length !== 1) return null;
  const position = /^  \((\d+)\/(\d+)\)$/.exec(rows.at(-1)!);
  if (position) rows.pop();
  if (cursor >= rows.length) return null;
  const matches: GjcAskMenu[] = [];
  for (const call of asks) {
    if (!completeText(call.id)) continue;
    const args = object(call.args);
    if (!Array.isArray(args?.questions) || args.questions.length === 0) continue;
    const questions = args.questions;
    if (questions.some((value) => {
      const q = object(value);
      return !q || !completeText(q.question) || !Array.isArray(q.options)
        || (q.multi !== undefined && typeof q.multi !== "boolean")
        || q.options.some((option) => !completeText(object(option)?.label));
    })) continue;
    for (const [questionIndex, value] of questions.entries()) {
      const q = object(value);
      if (!q || !completeText(q.question) || q.multi === true || !Array.isArray(q.options)) continue;
      const options = q.options.map((option) => object(option)?.label);
      // Incomplete/malformed/richly transformed titles fail closed, not an approximation of
      // the native deep-interview semantic renderer. Plain metadata questions are supported.
      if (options.some((label) => typeof label !== "string" || !label.trim() || /[\r\n\t\u001b]/.test(label))) continue;
      const pages = questions.length > 1;
      if (!footers(pages).some((hint) => compact(hint) === footer)) continue;
      const question = q.question;
      const heading = `${question}${pages ? ` (${questionIndex + 1}/${questions.length})` : ""}`;
      // HookSelector appends its own countdown to the title, not to the question identity.
      const untimedTitle = [...title];
      if (untimedTitle.length) untimedTitle[untimedTitle.length - 1] = untimedTitle.at(-1)!.replace(/\s*\(\d+s\)$/, "");
      if (!wholeWrapped(title, heading) && !wholeWrapped(untimedTitle.filter(Boolean), heading)) continue;
      const numbered = q.deepInterview !== undefined || /(?:^|\n)\s*Round\s+\d+\s*\|.*?\bAmbiguity\b/i.test(question);
      const number = (label: string, index: number) => /^\s*\d+[.)]\s+/.test(label) ? label : `${index + 1}. ${label}`;
      const labels = (options as string[]).map((label, index) => numbered ? number(label, index) : label);
      const recommended = q.recommended;
      if (labels.length > 1 && typeof recommended === "number" && Number.isInteger(recommended) && recommended >= 0 && recommended < labels.length
        && !labels[recommended]!.endsWith(" (Recommended)")) labels[recommended] = labels[recommended]! + " (Recommended)";
      labels.push(numbered ? number(OTHER, labels.length) : OTHER);
      if (numbered) labels.push(number(CLARIFY, labels.length));
      if (new Set(labels).size !== labels.length) continue;
      for (let selectedIndex = 0; selectedIndex < labels.length; selectedIndex += 1) {
        if (position && (Number(position[1]) !== selectedIndex + 1 || Number(position[2]) !== labels.length)) continue;
        const start = selectedIndex - cursor;
        if (start < 0) continue;
        for (let focusedRows = 1; focusedRows <= rows.length - cursor; focusedRows += 1) {
          const end = selectedIndex + rows.length - cursor - focusedRows + 1;
          if (end > labels.length || Boolean(position) !== (start > 0 || end < labels.length)) continue;
          const focus = rows.slice(cursor, cursor + focusedRows).map((row) => row.slice(2));
          // Omitted focused rows are not enough evidence for this implementation.
          if (focus.some((row) => Bun.stringWidth(row) > width) || !wholeWrapped(focus, labels[selectedIndex]!)) continue;
          if (!rows.slice(0, cursor).every((row, index) => sibling(row.slice(2), labels[start + index]!, width))) continue;
          if (!rows.slice(cursor + focusedRows).every((row, index) => sibling(row.slice(2), labels[selectedIndex + 1 + index]!, width))) continue;
          matches.push({ call: call.id, questionIndex, question, labels, selectedIndex });
        }
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}
