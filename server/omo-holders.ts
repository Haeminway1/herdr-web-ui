import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A holder's start is floored to the second (as `ps -o lstart`), ours is in clock ticks.
const HOLDER_START_TOLERANCE_MS = 3000;

/**
 * omo keeps no descriptor on its session file, but every process with a session open
 * publishes <session dir>/session-holders/<encoded id>/<pid>.json and removes it on
 * release (/new, /resume, exit). A crashed process leaves its record behind, so one
 * counts only for the live pid it names and, where our start time is readable, only
 * if it started when that pid did: a reused pid starts later.
 */
export function heldSessionIds(dir: string, pid: number, startedAt: number | null, cwd?: string): string[] {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return []; }
  const ids: string[] = [];
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid !== pid) continue;
      if (cwd !== undefined && record.cwd !== cwd) continue;
      if (startedAt !== null && !(typeof record.processStartedAtMs === "number" && Math.abs(record.processStartedAtMs - startedAt) <= HOLDER_START_TOLERANCE_MS)) continue;
      ids.push(decodeURIComponent(name));
    } catch { /* this pid holds nothing here, or the record is unreadable */ }
  }
  return ids;
}
