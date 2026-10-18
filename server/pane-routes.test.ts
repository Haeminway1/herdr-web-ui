import { expect, it, spyOn } from "bun:test";
import * as conversation from "./conversation.ts";
import { ConversationUnavailable } from "./conversation.ts";
import { GjcSdkLookupError } from "./gjc-sdk.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import type { ManagedSessionIdentity } from "../shared/protocol.ts";

const route = (paneId = "wFixture:p1") => {
  const url = new URL(`http://localhost/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  return handlePaneRequest(new Request(url), url, "/api/pane/conversation", {});
};

it.each([["timeout", 504], ["unavailable", 503]] as const)("returns a sanitized retryable GJC %s response", async (reason, status) => {
  const lookup = spyOn(conversation, "paneConversation").mockImplementation(async () => { throw new GjcSdkLookupError(reason); });
  try {
    const response = await route();
    expect(response?.status).toBe(status);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ error: { code: `gjc_sdk_${reason}`, message: "GJC SDK lookup failed" } });
  } finally { lookup.mockRestore(); }
});

it("returns managed identity state without enabling scrollback fallback", async () => {
  const managed: ManagedSessionIdentity = { id: "0123456789abcdef0123456789abcdef", harness: "gjc", generation: 2, state: "blocked", reason: "blocked_gjc_generation_changed", session_id: null };
  const lookup = spyOn(conversation, "paneConversation").mockImplementation(async () => { throw new ConversationUnavailable(managed.reason ?? "blocked", managed); });
  try {
    const response = await route();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ source: "scrollback", turns: [], managed_session: managed });
  } finally { lookup.mockRestore(); }
});
