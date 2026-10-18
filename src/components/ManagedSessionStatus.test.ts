import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ManagedSessionIdentity } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ManagedSessionStatus } from "./ManagedSessionStatus.tsx";

const identity = (state: ManagedSessionIdentity["state"], reason: string | null = null): ManagedSessionIdentity => ({
  id: null, harness: "gjc", generation: null, state, reason, session_id: null,
});

const render = (state: ManagedSessionIdentity["state"], reason?: string): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ManagedSessionStatus, { identity: identity(state, reason ?? null) }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("managed session status in chat", () => {
  it("shows pending identity as a non-badge status", () => {
    const html = render("identity_pending");
    expect(html).toContain('role="status"');
    expect(html).toContain('data-managed-state="identity_pending"');
    expect(html).toContain("Waiting for managed session identity");
    expect(html).not.toContain('class="badge');
  });

  it("shows the blocked reason without inventing a transcript", () => {
    const html = render("blocked", "session_identity_conflict");
    expect(html).toContain('data-managed-state="blocked"');
    expect(html).toContain("Managed session blocked: session_identity_conflict");
    expect(html).not.toContain('class="badge');
  });

  it("labels ready identity without a warning", () => {
    const html = render("ready");
    expect(html).toContain("Session identified");
    expect(html).not.toContain("blocked");
    expect(html).not.toContain("Waiting for");
  });
});
