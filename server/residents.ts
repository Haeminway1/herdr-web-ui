import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { badRequest, jsonResponse } from "./http.ts";
import { sanitizeResidents, type Residents } from "../shared/residents.ts";

/** fork: the sidebar's resident agents (shared/residents.ts), one small file in the state dir. */
export class ResidentStore {
  constructor(private readonly file: string) {}

  read(): Residents {
    try { return sanitizeResidents(JSON.parse(readFileSync(this.file, "utf8"))); }
    catch { return sanitizeResidents({}); }
  }

  write(value: unknown): Residents {
    const residents = sanitizeResidents(value);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(residents, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
    return residents;
  }
}

/** GET /api/residents → the list; PUT with a whole record replaces it (the answer is what was kept). */
export async function handleResidentsRequest(request: Request, store: ResidentStore): Promise<Response> {
  if (request.method === "GET") return jsonResponse(store.read(), 200, { "cache-control": "no-store" });
  if (request.method !== "PUT") return badRequest("method_not_allowed", "use GET or PUT");
  let payload: unknown;
  try { payload = await request.json(); }
  catch { return badRequest("invalid_json", "request body must be JSON"); }
  return jsonResponse(store.write(payload));
}
