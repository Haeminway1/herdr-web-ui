import { describe, expect, it } from "bun:test";
import { GjcSdkLookupError } from "./gjc-sdk-error.ts";
import { gjcSdkGenerationCurrent, type GjcSdkGenerationObserver } from "./gjc-sdk-generation.ts";

describe("SDK generation revocation", () => {
  it("rechecks the exact native generation on every read rather than caching a positive proof", async () => {
    let status = "current";
    const calls: [string, number][] = [];
    const observer: GjcSdkGenerationObserver = { generationStatus: async (id, generation) => { calls.push([id, generation]); return { status }; } };
    expect(await gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, observer)).toBe(true);
    status = "retired";
    expect(await gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, observer)).toBe(false);
    expect(calls).toEqual([["session-a", 4], ["session-a", 4]]);
  });

  it.each(["retired", "replaced", "unknown", "", "CURRENT"])("refuses %s generation evidence", async (status) => {
    expect(await gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, { generationStatus: async () => ({ status }) })).toBe(false);
  });

  it("reports unavailable without leaking discovery or generation execution failures", async () => {
    const unavailable = Promise.reject<GjcSdkGenerationObserver>(new Error("SDK unavailable"));
    await expect(gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, unavailable)).rejects.toEqual(new GjcSdkLookupError("unavailable"));
    await expect(gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, { generationStatus: async () => { throw new Error("secret index unavailable"); } })).rejects.toEqual(new GjcSdkLookupError("unavailable"));
  });

  it.each(["ENOENT", "EACCES", "BROKER", "ETIMEDOUT"])("sanitizes %s discovery and generation API failures", async (code) => {
    const secret = `private ${code} session credentials`;
    const unavailable = Promise.reject<GjcSdkGenerationObserver>(Object.assign(new Error(secret), { code }));
    for (const observer of [unavailable, { generationStatus: async () => { throw Object.assign(new Error(secret), { code }); } }]) {
      const failure = await gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, observer).catch(error => error);
      expect(failure).toBeInstanceOf(GjcSdkLookupError);
      expect(failure).toMatchObject({ reason: code === "ETIMEDOUT" ? "timeout" : "unavailable", message: "GJC SDK lookup failed" });
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
  });

  it("bounds a hung generation observation without accepting cached broker evidence", async () => {
    const observer: GjcSdkGenerationObserver = { generationStatus: () => new Promise(() => {}) };
    await expect(gjcSdkGenerationCurrent("/fixture/agent", "session-a", 4, observer)).rejects.toEqual(new GjcSdkLookupError("timeout"));
  });
});
