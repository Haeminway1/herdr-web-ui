import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { handlePromptRequest, noteSubmitted, prepareCommandSend } from "./prompt.ts";
import type { HerdrPane, PanePromptResponse } from "../shared/protocol.ts";
import { commandInvocations, commandTranscriptRecords, CommandReservations, type CommandSend } from "./outcome.ts";

afterEach(() => mock.restore());

it.each(["identity_pending", "blocked", "ready"] as const)("does not borrow command evidence across a managed %s transition", async state => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  spyOn(Date, "now").mockReturnValue(at);
  const pane: HerdrPane = {
    pane_id: `managed-outcome-${state}`, workspace_id: "w", tab_id: "t", terminal_id: "term",
    cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle",
    managed_session: { id: "a".repeat(32), generation: 1, harness: "claude", session_id: "same-session", state: "ready", reason: null },
  };
  spyOn(client, "sessionSnapshot").mockImplementation(async () => ({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  }));
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const transcript = spyOn(conversation, "readCommandTranscript").mockResolvedValue({ identity: "fixture", records: commandTranscriptRecords([
    { type: "system", subtype: "local_command", timestamp: new Date(at + 1).toISOString(), content: "<command-name>/context</command-name>" },
    { type: "system", subtype: "local_command", timestamp: new Date(at + 2).toISOString(), content: "<local-command-stdout>other-generation</local-command-stdout>" },
  ].map(entry => JSON.stringify(entry)).join("\n")) });
  const sent = prepareCommandSend(pane, "/context")!;
  expect(sent).toBeDefined();
  noteSubmitted(pane.pane_id, sent.text, sent);
  pane.managed_session = { ...pane.managed_session!, generation: 2, state };
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
  const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
  expect(shown.outcomes ?? []).toEqual([]);
  if (state === "ready") {
    const current = prepareCommandSend(pane, "/context")!;
    expect(current.identity).not.toBe(sent.identity);
    transcript.mockResolvedValue({ identity: "current-generation", records: [] });
    noteSubmitted(pane.pane_id, current.text, current);
    const refreshed = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(refreshed.outcomes?.map(({ id, state }) => [id, state])).toEqual([[current.id, "accepted"]]);
  } else {
    expect(screen).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  }
});

for (const delayed of [true, false]) {
  it(`assigns repeated /context records FIFO once unambiguous when the first result is ${delayed ? "after" : "before"} the second send`, async () => {
    const at = Date.parse("2026-10-20T00:00:00Z");
    let now = at;
    spyOn(Date, "now").mockImplementation(() => now);
    const pane = { pane_id: `transcript-${delayed}`, workspace_id: "w", tab_id: "t", terminal_id: "terminal",
      cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
    spyOn(client, "sessionSnapshot").mockResolvedValue({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture", focused_workspace_id: null });
    spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
    let transcript = "";
    spyOn(conversation, "readCommandTranscript").mockImplementation(async () => ({ identity: "fixture", records: commandTranscriptRecords(transcript) }));
    const sent = (id: string) => {
      const command = { id, text: "/context", at: now, agent: "claude", screen: "", store: null,
        identity: JSON.stringify([pane.terminal_id, undefined]), form: null,
        invocations: commandInvocations("claude", "/context", []) };
      noteSubmitted(pane.pane_id, command.text, command);
      return command;
    };
    const poll = async () => {
      const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
      return await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    };
    const records = (time: number) => [
      { type: "system", subtype: "local_command", timestamp: new Date(time).toISOString(),
        content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" },
      { type: "system", subtype: "local_command", timestamp: new Date(time + 1).toISOString(),
        content: "<local-command-stdout>fixture-output</local-command-stdout>" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    sent("first");
    if (!delayed) { now += 10; transcript = records(now); await poll(); }
    now += 100;
    sent("second");
    now += 10;
    if (delayed) transcript = records(now);
    expect((await poll()).outcomes?.map(({ id, state }) => [id, state])).toEqual([
      ["first", delayed ? "unknown" : "result-observed"], ["second", "accepted"],
    ]);
    now += 10;
    transcript += records(now);
    expect((await poll()).outcomes?.map(({ id, state }) => [id, state])).toEqual([
      ["first", "result-observed"], ["second", "result-observed"],
    ]);
    expect((await poll()).outcomes?.map(({ state }) => state)).toEqual(["result-observed", "result-observed"]);
  });
}

it("keeps a delayed record reserved after a plain message closes the older send", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  const first: CommandSend = { id: "first", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null, invocations: commandInvocations("claude", "/context", []) };
  const second = { ...first, id: "second", at: at + 100 };
  const reservations = new CommandReservations();
  reservations.add(first, []);
  reservations.close("Please continue", at + 50);
  reservations.add(second, []);
  const records = commandTranscriptRecords(JSON.stringify({ type: "user", timestamp: new Date(at + 110).toISOString(), message: { content: "/context" } }));
  reservations.observeTranscript("fixture", "store", records, second.id);
  expect(first.transcriptEvidence?.at).toBe(at + 110);
  expect(first.transcriptClosedAt).toBe(at + 50);
  expect(second.transcriptEvidence).toBeUndefined();
});

it("does not reassign a consumed record when its older send expires", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  const first: CommandSend = { id: "first", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null, invocations: commandInvocations("claude", "/context", []) };
  const second = { ...first, id: "second", at: at + 100 };
  const reservations = new CommandReservations();
  reservations.add(first, []);
  reservations.add(second, []);
  const records = commandTranscriptRecords(JSON.stringify({ type: "user", timestamp: new Date(at + 110).toISOString(), message: { content: "/context" } }));
  reservations.observeTranscript("fixture", "store", records, second.id);
  reservations.prune(at + 600_000);
  reservations.observeTranscript("fixture", "store", records, second.id);
  expect(second.transcriptEvidence).toBeUndefined();
});

it("does not give a newer send the first record after an unresolved older send expires", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  const first: CommandSend = { id: "first", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null, invocations: commandInvocations("claude", "/context", []) };
  const second = { ...first, id: "second", at: at + 100 };
  const reservations = new CommandReservations();
  reservations.add(first, []);
  reservations.add(second, []);
  reservations.prune(at + 600_000);
  const records = commandTranscriptRecords(JSON.stringify({ type: "user", timestamp: new Date(at + 600_001).toISOString(), message: { content: "/context" } }));
  reservations.observeTranscript("fixture", "store", records, second.id);
  expect(second.transcriptEvidence).toBeUndefined();
});
