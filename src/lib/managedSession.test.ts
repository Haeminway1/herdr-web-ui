import { describe, expect, it } from "bun:test";
import type { ManagedSessionIdentity } from "../../shared/protocol.ts";
import { managedSessionTransient, sameManagedSession } from "./managedSession.ts";

const identity = (overrides: Partial<ManagedSessionIdentity> = {}): ManagedSessionIdentity => ({
  id: "0123456789abcdef0123456789abcdef",
  harness: "gjc",
  generation: 1,
  state: "ready",
  reason: null,
  session_id: "00000000-0000-4000-8000-000000000001",
  ...overrides,
});

describe("managed session history retention", () => {
  it("keeps already displayed history only for the same nonce, generation and harness", () => {
    const shown = identity();
    expect(sameManagedSession(shown, identity())).toBe(true);
    expect(sameManagedSession(shown, identity({ harness: "omo" }))).toBe(false);
    expect(sameManagedSession(shown, identity({ harness: "claude" }))).toBe(false);
    expect(sameManagedSession(shown, identity({ harness: null }))).toBe(false);
    expect(sameManagedSession(shown, identity({ generation: 2 }))).toBe(false);
    expect(sameManagedSession(shown, identity({ id: "f".repeat(32) }))).toBe(false);
  });

  it("preserves displayed history while a transient check has no session id", () => {
    const shown = identity();
    const transient = identity({ state: "identity_pending", reason: "identity_pending", session_id: null });
    expect(managedSessionTransient(transient)).toBe(true);
    expect(sameManagedSession(shown, transient)).toBe(true);
  });

  it("clears displayed history when the session or harness is proven different", () => {
    const shown = identity();
    expect(sameManagedSession(shown, identity({ session_id: "00000000-0000-4000-8000-000000000002" }))).toBe(false);
    const readOnly = identity({ state: "blocked", reason: "blocked_runtime_changed", readable: true });
    expect(managedSessionTransient(readOnly)).toBe(true);
    expect(sameManagedSession(shown, readOnly)).toBe(true);
    expect(sameManagedSession(shown, { ...readOnly, harness: "codex" })).toBe(false);
  });
});
