import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GJC_NATIVE_DIRECTORY } from "../shared/gjc-native.ts";
import { forgetGjcState, gjcTranscriptForPane } from "./gjc-pane.ts";
import * as runtime from "./gjc-runtime.ts";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";

const roots: string[] = [];
afterEach(() => { forgetGjcState(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ovis-gjc-authority-")));
  roots.push(home);
  const records = join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY);
  const store = join(home, ".gjc", "agent", "sessions", "project");
  fs.mkdirSync(records, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const path = join(store, "session.jsonl");
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "native-session", cwd: home }) + "\n");
  const record = join(records, "424242.json");
  const publish = () => fs.writeFileSync(record, JSON.stringify({ version: 1, pid: 424242, processStartedAt: 1000, instanceId: "fixture", sequence: 1, updatedAt: 10000, session: { id: "native-session", path, cwd: home } }));
  const options = { platform: "linux", now: () => 10000, processBirth: () => 1000, processInfo: async () => ({ process_info: { foreground_processes: [{ pid: 424242, argv: ["gjc"] }] } }) };
  return { home, path, record, publish, options };
}

it("retains exact SDK discovery without a native extension record", async () => {
  const f = fixture();
  const sdk = spyOn(runtime, "gjcTranscriptForPane").mockResolvedValue(f.path);
  try {
    expect(await gjcTranscriptForPane("sdk", f.home, f.home, f.options)).toBe(f.path);
    expect(sdk).toHaveBeenCalledTimes(1);
  } finally { sdk.mockRestore(); }
});

it("keeps native authority without invoking or authorizing the SDK child", async () => {
  const f = fixture(); f.publish();
  const sdk = spyOn(runtime, "gjcTranscriptForPane").mockResolvedValue("wrong-child");
  try {
    expect(await gjcTranscriptForPane("native", f.home, f.home, f.options)).toBe(f.path);
    fs.writeFileSync(f.record, "{}");
    expect(await gjcTranscriptForPane("native", f.home, f.home, f.options)).toBeNull();
    expect(sdk).not.toHaveBeenCalled();
  } finally { sdk.mockRestore(); }
});

it("does not downgrade a disappeared native record to a cached SDK identity", async () => {
  const f = fixture(); f.publish();
  const sdk = spyOn(runtime, "gjcTranscriptForPane").mockResolvedValue("wrong-child");
  try {
    expect(await gjcTranscriptForPane("native", f.home, f.home, f.options)).toBe(f.path);
    fs.rmSync(f.record);
    await expect(gjcTranscriptForPane("native", f.home, f.home, f.options)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed" });
    expect(sdk).not.toHaveBeenCalled();
  } finally { sdk.mockRestore(); }
});

it("rejects an SDK result when native authority appears while the lookup awaits", async () => {
  const f = fixture();
  const sdk = spyOn(runtime, "gjcTranscriptForPane").mockImplementation(async () => { f.publish(); return f.path; });
  try {
    await expect(gjcTranscriptForPane("switch", f.home, f.home, f.options)).rejects.toBeInstanceOf(GjcSdkLookupError);
    expect(await gjcTranscriptForPane("switch", f.home, f.home, f.options)).toBe(f.path);
    expect(sdk).toHaveBeenCalledTimes(1);
  } finally { sdk.mockRestore(); }
});

for (const code of ["ENOENT", "EACCES"]) {
  it(`keeps native transcript ${code} sanitized and unavailable rather than empty`, async () => {
    const f = fixture(); f.publish();
    const original = fs.openSync;
    const read = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === f.path) throw Object.assign(new Error("private fixture path"), { code });
      return Reflect.apply(original, fs, [path, ...args]);
    }) as typeof fs.openSync);
    try {
      await expect(gjcTranscriptForPane("native-error", f.home, f.home, f.options)).rejects.toMatchObject({ name: "GjcSdkLookupError", reason: "unavailable", message: "GJC SDK lookup failed" });
    } finally { read.mockRestore(); }
  });
}
