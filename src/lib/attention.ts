import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, PaneAttention, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { panesNeedingInput } from "./needsInput.ts";

export interface AttentionEntry { machine: Machine; pane: HerdrPane; workspace: WorkspaceInfo }

/**
 * What needs the user, across every PC: a question waiting (`needsInput`), an answer not read
 * yet (`toRead`, newest first) and work still going on (`working`). A pane read, or at rest
 * with nothing new, can be left alone and is in none of them.
 */
export interface AttentionGroups { needsInput: AttentionEntry[]; toRead: AttentionEntry[]; working: AttentionEntry[] }

/** It finished after it was last opened (server/attention.ts), and is at rest now. */
export function isUnread(pane: HerdrPane): boolean {
  const state = pane.attention;
  if (!state?.finished_at || pane.agent_status === "working" || pane.agent_status === "blocked") return false;
  return state.seen_at === null || Date.parse(state.seen_at) < Date.parse(state.finished_at);
}

/** Offline rosters are cached: like Needs you, only connected PCs say what is going on now. */
export function attentionGroups(machines: readonly Machine[]): AttentionGroups {
  const toRead: AttentionEntry[] = [];
  const working: AttentionEntry[] = [];
  for (const machine of machines) {
    if (machine.state !== "connected" || !machine.snapshot) continue;
    const { panes, workspaces } = machine.snapshot;
    for (const workspace of workspaces) {
      for (const pane of panes as HerdrPane[]) {
        if (pane.workspace_id !== workspace.workspace_id) continue;
        if (isUnread(pane)) toRead.push({ machine, pane, workspace });
        else if (pane.agent_status === "working") working.push({ machine, pane, workspace });
      }
    }
  }
  // newest first: the answer that just came in is the one the user is waiting for
  toRead.sort((a, b) => Date.parse(b.pane.attention!.finished_at!) - Date.parse(a.pane.attention!.finished_at!));
  return { needsInput: panesNeedingInput(machines), toRead, working };
}

/** A pushed `pane-attention` merged into a snapshot; the same object when nothing changed. */
export function applyPaneAttention(snapshot: SessionSnapshot, paneId: string, attention: PaneAttention): SessionSnapshot {
  let changed = false;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    if (pane.pane_id !== paneId || JSON.stringify(pane.attention) === JSON.stringify(attention)) return pane;
    changed = true;
    return { ...pane, attention };
  });
  return changed ? { ...snapshot, panes } : snapshot;
}
