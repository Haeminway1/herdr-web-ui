import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgyUnavailable, agyCatalog, agyDatabasePath, forgetAgyState, parseAgyTranscript } from "./agy.ts";
import { forgetTranscriptState, HistoryChanged, transcriptPage, transcriptToolOutput } from "./conversation.ts";

/** Writes a WAL catalog from a process that then dies without closing it, as agy does when killed:
 * nothing checkpoints, and no handle stays open, so a test may delete side files on any platform. */
async function abandonedWal(dbPath: string, sql: string): Promise<void> {
  const writer = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    new Database(${JSON.stringify(dbPath)}).exec(${JSON.stringify(sql)});
    process.kill(process.pid, "SIGKILL");
  `], { stdout: "ignore", stderr: "pipe" });
  const [stderr] = await Promise.all([new Response(writer.stderr).text(), writer.exited]);
  expect(stderr).toBe("");
  expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([true, true]);
}

it("reads and caches a large WAL catalog without copying on a warm read", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-large-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(idx INTEGER PRIMARY KEY, payload BLOB); INSERT INTO steps VALUES (0, zeroblob(67108864)); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1, zeroblob(67108864));");
      expect(fs.statSync(dbPath).size + fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(128 * 1024 * 1024);
      const cold = performance.now();
      const result = agyCatalog(transcript);
      const coldMs = performance.now() - cold;
      expect([...result]).toEqual([0, 1]);
      result.clear();
      const writes = spyOn(fs, "writeFileSync");
      try {
        const warm = performance.now();
        expect([...agyCatalog(transcript)]).toEqual([0, 1]);
        console.log(`AGY 128 MiB cold ${coldMs.toFixed(1)} ms, warm ${(performance.now() - warm).toFixed(1)} ms`);
        expect(writes).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); }
    } finally { writer.close(); }
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("preserves paging and tool output across large WAL growth and rejects them after rewind", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-large-paging-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "");
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(idx INTEGER PRIMARY KEY); CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES (zeroblob(34603008))");
      const add = (index: number, type: string, content: string) => {
        writer.query("INSERT INTO steps VALUES (?)").run(index);
        fs.appendFileSync(transcript, JSON.stringify({ step_index: index, type, status: "DONE", content }) + "\n");
      };
      writer.transaction(() => { for (let i = 0; i < 51; i++) { add(i * 2, "USER_INPUT", `prompt ${i}`); add(i * 2 + 1, "GENERIC", "x".repeat(5000)); } })();
      const first = transcriptPage("agy-transcript", transcript);
      expect(first.cursor).not.toBeNull();
      const older = transcriptPage("agy-transcript", transcript, { before: first.cursor! });
      const tool = first.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
      if (!tool || tool.kind !== "tool") throw new Error("missing tool output");
      expect(transcriptToolOutput("agy-transcript", transcript, tool.output_ref!)).toBe("x".repeat(5000));
      add(102, "USER_INPUT", "appended");
      expect(transcriptPage("agy-transcript", transcript).history_id).toBe(first.history_id);
      expect(transcriptPage("agy-transcript", transcript, { before: first.cursor! })).toEqual(older);
      writer.exec("DELETE FROM steps WHERE idx >= 4");
      expect(transcriptPage("agy-transcript", transcript).history_id).not.toBe(first.history_id);
      expect(() => transcriptPage("agy-transcript", transcript, { before: first.cursor! })).toThrow(HistoryChanged);
      expect(transcriptToolOutput("agy-transcript", transcript, tool.output_ref!)).toBeNull();
    } finally { writer.close(); }
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("invalidates catalog versions on WAL growth, rewind, checkpoint and same-content writes", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-versions-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0)");
      expect([...agyCatalog(transcript)]).toEqual([0]);
      writer.exec("INSERT INTO steps VALUES (1)");
      expect([...agyCatalog(transcript)]).toEqual([0, 1]);
      writer.exec("DELETE FROM steps WHERE idx=1");
      expect([...agyCatalog(transcript)]).toEqual([0]);
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      fs.utimesSync(dbPath, 1700000000, 1700000000);
      expect([...agyCatalog(transcript)]).toEqual([0]);
      const writes = spyOn(fs, "writeFileSync");
      try {
        expect([...agyCatalog(transcript)]).toEqual([0]);
        expect(writes).not.toHaveBeenCalled();
        const before = fs.statSync(dbPath, { bigint: true });
        const file = fs.openSync(dbPath, "r+");
        try {
          const byte = Buffer.alloc(1);
          fs.readSync(file, byte, 0, 1, 0);
          fs.writeSync(file, byte, 0, 1, 0);
        } finally { fs.closeSync(file); }
        fs.utimesSync(dbPath, 1700000000, 1700000000);
        const after = fs.statSync(dbPath, { bigint: true });
        expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
        expect(after.ctimeNs).not.toBe(before.ctimeNs);
        expect([...agyCatalog(transcript)]).toEqual([0]);
        expect(writes).toHaveBeenCalled();
        writes.mockClear();
        forgetAgyState(transcript);
        expect([...agyCatalog(transcript)]).toEqual([0]);
        expect(writes).toHaveBeenCalled();
        writes.mockClear();
        forgetAgyState();
        expect([...agyCatalog(transcript)]).toEqual([0]);
        expect(writes).toHaveBeenCalled();
      } finally { writes.mockRestore(); }
    } finally { writer.close(); }
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["database", "wal", "shm"] as const)("rejects %s replacement during a cache hit and evicts the entry", (name) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-hit-race-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0)");
      expect([...agyCatalog(transcript)]).toEqual([0]);
      const target = name === "database" ? dbPath : `${dbPath}-${name}`;
      const replacement = `${target}.replacement`;
      fs.copyFileSync(target, replacement);
      expect(() => agyCatalog(transcript, () => fs.renameSync(replacement, target))).toThrow(AgyUnavailable);
      const writes = spyOn(fs, "writeFileSync");
      try {
        expect([...agyCatalog(transcript)]).toEqual([0]);
        expect(writes).toHaveBeenCalled();
      } finally { writes.mockRestore(); }
    } finally { writer.close(); }
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects a sidefile removed on a cache hit without recreating it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-hit-unlink-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1)");
    expect([...agyCatalog(transcript)]).toEqual([0, 1]);
    expect(() => agyCatalog(transcript, () => rmSync(`${dbPath}-wal`))).toThrow(AgyUnavailable);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect([...agyCatalog(transcript)]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("cleans a failed private snapshot without changing source files", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-copy-error-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0)");
    const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const contents = paths.map((path) => readFileSync(path));
    const temp = spyOn(fs, "mkdtempSync");
    const writes = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("copy failed"); });
    try {
      expect(() => agyCatalog(transcript)).toThrow(AgyUnavailable);
      const snapshot = temp.mock.results[0]?.value;
      expect(typeof snapshot).toBe("string");
      expect(existsSync(snapshot as string)).toBe(false);
      expect(paths.map((path) => readFileSync(path))).toEqual(contents);
    } finally { temp.mockRestore(); writes.mockRestore(); }
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("opens private snapshots under a symlinked temporary directory", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-temp-link-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try { writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (7)"); }
    finally { writer.close(); }
    const target = join(dir, "temp");
    const link = join(dir, "temp-link");
    mkdirSync(target);
    fs.symlinkSync(target, link, "dir");
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      console.log(JSON.stringify([...agyCatalog(${JSON.stringify(transcript)})]));
    `], { env: { ...process.env, TMPDIR: link }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([7]);
    expect(fs.readdirSync(target)).toEqual([]);
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("evicts least recently used catalog paths and limits total cached indices", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-lru-")));
  const paths: string[] = [];
  try {
    for (let i = 0; i < 19; i++) {
      const transcript = join(dir, "brain", `session${i}`, ".system_generated", "logs", "transcript_full.jsonl");
      const dbPath = agyDatabasePath(transcript);
      mkdirSync(dirname(dbPath), { recursive: true });
      const writer = new Database(dbPath);
      try {
        writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
        if (i >= 17) writer.exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<50000) INSERT INTO steps SELECT x FROM n");
        else writer.exec("INSERT INTO steps VALUES (0)");
      } finally { writer.close(); }
      paths.push(transcript);
    }
    for (let i = 0; i < 16; i++) agyCatalog(paths[i]!);
    agyCatalog(paths[0]!);
    agyCatalog(paths[16]!);
    const writes = spyOn(fs, "writeFileSync");
    try {
      agyCatalog(paths[0]!);
      expect(writes).not.toHaveBeenCalled();
      agyCatalog(paths[1]!);
      expect(writes).toHaveBeenCalled();
      forgetAgyState();
      agyCatalog(paths[17]!);
      agyCatalog(paths[18]!);
      writes.mockClear();
      agyCatalog(paths[18]!);
      expect(writes).not.toHaveBeenCalled();
      agyCatalog(paths[17]!);
      expect(writes).toHaveBeenCalled();
    } finally { writes.mockRestore(); }
  } finally { forgetAgyState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads a stable rollback-journal catalog without creating side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-rollback-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0);");
    } finally { writer.close(); }

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("reads a checkpointed WAL catalog without recreating missing side files", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    } finally { writer.close(); }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    expect([...readFileSync(dbPath).subarray(18, 20)]).toEqual([2, 2]);

    const catalog = agyCatalog(transcript);

    expect([...catalog]).toEqual([0]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ["database", 512 * 1024 * 1024 + 1, 0],
  ["WAL", 8192, 512 * 1024 * 1024 + 1],
  ["combined", 256 * 1024 * 1024, 256 * 1024 * 1024 + 1],
] as const)("rejects an oversized %s before copying the catalog", (_name, dbBytes, walBytes) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-catalog-limit-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    const writer = new Database(dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
      truncateSync(dbPath, dbBytes);
      truncateSync(`${dbPath}-wal`, walBytes);
      const reads = spyOn(fs, "readSync");
      // A regression fails on its first write instead of materializing the sparse files.
      const writes = spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("unexpected snapshot write"); });
      try {
        expect(() => agyCatalog(transcript)).toThrow(AgyUnavailable);
        expect(reads).toHaveBeenCalledTimes(1);
        expect(reads.mock.calls[0]?.[1].byteLength).toBe(20);
        expect(writes).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); reads.mockRestore(); }
    } finally { writer.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["wal", "shm", null] as const)("reads a WAL catalog with %s missing without changing side files", async (missing) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-pair-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO steps VALUES (1);");
    if (missing !== null) rmSync(`${dbPath}-${missing}`);
    const before = [existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)];
    expect(before).toEqual([missing !== "wal", missing !== "shm"]);

    // A separate process avoids sharing the writer's in-process SQLite state.
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      console.log(JSON.stringify([...agyCatalog(${JSON.stringify(transcript)})]));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual(before);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // Incomplete pairs read only the checkpointed main file, as session-history does.
    expect(JSON.parse(stdout)).toEqual(missing === null ? [0, 1] : [0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not recreate a live WAL pair unlinked between its check and open", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-wal-unlink-")));
  try {
    const transcript = join(dir, "brain", "session", ".system_generated", "logs", "transcript_full.jsonl");
    const dbPath = agyDatabasePath(transcript);
    mkdirSync(dirname(dbPath), { recursive: true });
    await abandonedWal(dbPath, "PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY); INSERT INTO steps VALUES (0); PRAGMA wal_checkpoint(TRUNCATE);");
    const reader = Bun.spawn([process.execPath, "-e", `
      import { agyCatalog, AgyUnavailable } from ${JSON.stringify(new URL("./agy.ts", import.meta.url).href)};
      import { existsSync, rmSync } from "node:fs";
      const path = ${JSON.stringify(dbPath)};
      let removed = false;
      let rows = null;
      try {
        rows = [...agyCatalog(${JSON.stringify(transcript)}, () => {
          if (!existsSync(path + "-wal") || !existsSync(path + "-shm")) throw new Error("pair missing before hook");
          rmSync(path + "-wal");
          rmSync(path + "-shm");
          removed = true;
        })];
      } catch (error) {
        if (!(error instanceof AgyUnavailable)) throw error;
      }
      console.log(JSON.stringify({ removed, rows }));
    `], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
    ]);

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([false, false]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.removed).toBe(true);
    expect([null, [0]]).toContainEqual(result.rows);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the recorded skill invocation without its expanded metadata", () => {
  const fixture = readFileSync(new URL("./fixtures/skill-invocations/agy.jsonl", import.meta.url), "utf8");
  const turns = parseAgyTranscript(fixture);
  expect(turns.filter(({ role }) => role === "user").map(({ parts }) => parts)).toEqual([
    [{ kind: "text", text: "/probe-skill hello" }],
  ]);
});

it("keeps raw input when it is not a complete recognized envelope", () => {
  const content = "<USER_REQUEST>\n/probe-skill hello\n</USER_REQUEST>\n<OTHER>raw</OTHER>";
  const turns = parseAgyTranscript(JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content }));
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: content }]);
});
