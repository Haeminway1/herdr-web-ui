import { afterEach, describe, expect, it } from "bun:test";

import { refreshResidents, toggleResident, updateResidents } from "./residents.ts";
import { DEFAULT_RESIDENTS, type Residents } from "../../shared/residents.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call {
  init: RequestInit | undefined;
  answer: (response: Response) => void;
  fail: (reason: unknown) => void;
}

/** fetch whose calls wait for the test to answer them, kept in the order they arrived. */
function heldFetch(calls: Call[]): void {
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ init, answer: resolve, fail: reject });
  })) as typeof fetch;
}

/** lets the queued work run until the fetches it fired have arrived (bounded, no sleeps). */
async function untilCalls(calls: Call[], count: number): Promise<void> {
  for (let i = 0; i < 50 && calls.length < count; i++) await Promise.resolve();
  if (calls.length < count) throw new Error(`fetch was called ${calls.length} times, expected ${count}`);
}

const PIN = { folder: "/sys", workspace_id: "w1", pane_id: "p1", terminal_id: "t1" };

const state = (overrides: Partial<Residents> = {}): Residents => ({
  ...DEFAULT_RESIDENTS,
  launch: { ...DEFAULT_RESIDENTS.launch },
  top: ["/sys"],
  residents: ["/keep"],
  names: {},
  system_pin: PIN,
  ...overrides,
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** seeds the module with `body` through the real GET path. */
async function seed(calls: Call[], body: Residents): Promise<void> {
  const first = calls.length;
  const done = refreshResidents();
  await untilCalls(calls, first + 1);
  calls[first]!.answer(json(body));
  await done;
}

/** the list the next mutation starts from: an identity write answered with its own body. */
async function observe(calls: Call[]): Promise<Residents> {
  const first = calls.length;
  let seen: Residents | null = null;
  const done = updateResidents((residents) => { seen = residents; return residents; });
  await untilCalls(calls, first + 1);
  calls[first]!.answer(json(JSON.parse(String(calls[first]!.init?.body))));
  await done;
  return seen!;
}

describe("residents", () => {
  it("keeps a committed pin when a read begun during the write answers after it", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    await seed(calls, state());

    const write = updateResidents((residents) => ({ ...residents, residents: [...residents.residents, "/new"] }));
    const stale = refreshResidents();
    await untilCalls(calls, 3);
    // the read went out while the write was in flight and the server answers it with the old list
    expect(calls[1]!.init?.method ?? "GET").toBe("GET");
    expect(calls[2]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[2]!.init?.body)).residents).toEqual(["/keep", "/new"]);
    calls[2]!.answer(json(state({ residents: ["/keep", "/new"] })));
    await write;
    calls[1]!.answer(json(state({ residents: ["/keep"], system_pin: null })));
    await stale;

    const seen = await observe(calls);
    expect(seen.residents).toEqual(["/keep", "/new"]);
    expect(seen.system_pin).toEqual(PIN);
    expect(seen.top[0]).toBe("/sys");
  });

  it("ignores a read begun before the write when it lands after the answer", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    const stale = refreshResidents();
    await untilCalls(calls, 1);

    const write = updateResidents((residents) => ({ ...residents, residents: ["/new"] }));
    await untilCalls(calls, 2);
    calls[1]!.answer(json(state({ residents: ["/new"] })));
    await write;
    calls[0]!.answer(json(state({ residents: ["/keep"], system_pin: null })));
    await stale;

    const seen = await observe(calls);
    expect(seen.residents).toEqual(["/new"]);
    expect(seen.system_pin).toEqual(PIN);
  });

  it("reads the server's list back when a write is refused", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    await seed(calls, state({ names: { "/keep": "Keep" } }));

    const write = updateResidents((residents) => ({ ...residents, residents: [...residents.residents, "/new"] }));
    await untilCalls(calls, 2);
    expect(calls[1]!.init?.method).toBe("PUT");
    calls[1]!.answer(new Response("conflict", { status: 409 }));
    // the refusal makes the module re-read the server rather than keep the rollback alone
    await untilCalls(calls, 3);
    expect(calls[2]!.init?.method ?? "GET").toBe("GET");
    calls[2]!.answer(json(state({ residents: ["/keep", "/srv"], names: { "/keep": "Keep" } })));
    await write;

    const seen = await observe(calls);
    expect(seen.residents).toEqual(["/keep", "/srv"]);
    expect(seen.names).toEqual({ "/keep": "Keep" });
    expect(seen.system_pin).toEqual(PIN);
  });

  it("still re-reads after a refusal while a read was in flight", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    await seed(calls, state());

    const write = updateResidents((residents) => ({ ...residents, residents: [...residents.residents, "/new"] }));
    const stale = refreshResidents();
    await untilCalls(calls, 3);
    calls[2]!.answer(new Response("conflict", { status: 409 }));
    // the failed write waits for the in-flight read before refreshing: answer it with older state
    calls[1]!.answer(json(state({ residents: [], system_pin: null })));
    await stale;
    await untilCalls(calls, 4);
    calls[3]!.answer(json(state({ residents: ["/keep", "/srv"] })));
    await write;

    const seen = await observe(calls);
    expect(seen.residents).toEqual(["/keep", "/srv"]);
    expect(seen.system_pin).toEqual(PIN);
  });

  it("serializes writes so the next one builds on the committed answer", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    await seed(calls, state());

    const first = updateResidents((residents) => ({ ...residents, residents: [...residents.residents, "/a"] }));
    const second = updateResidents((residents) => ({ ...residents, residents: [...residents.residents, "/b"] }));
    await untilCalls(calls, 2);
    expect(calls).toHaveLength(2);
    // the second write does not reach the wire until the first has its answer
    calls[1]!.answer(json(state({ residents: ["/keep", "/a"] })));
    await untilCalls(calls, 3);
    expect(JSON.parse(String(calls[2]!.init?.body)).residents).toEqual(["/keep", "/a", "/b"]);
    calls[2]!.answer(json(JSON.parse(String(calls[2]!.init?.body))));
    await first;
    await second;

    const seen = await observe(calls);
    expect(seen.residents).toEqual(["/keep", "/a", "/b"]);
  });

  it("never writes when the pinned manager's folder is toggled", async () => {
    const calls: Call[] = [];
    heldFetch(calls);
    await seed(calls, state());

    await toggleResident("/sys");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toHaveLength(1);
    const seen = await observe(calls);
    expect(seen.top[0]).toBe("/sys");
    expect(seen.system_pin).toEqual(PIN);
  });
});
