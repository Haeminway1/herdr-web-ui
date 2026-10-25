import type { ManagedSessionIdentity } from "../../shared/protocol.ts";

/** A managed identity that may be waiting or readable despite a lifecycle block, never a proven identity change. */
export function managedSessionTransient(identity: ManagedSessionIdentity | undefined): boolean {
  return identity !== undefined && (identity.state === "identity_pending"
    || (identity.state === "blocked" && (identity.readable === true || identity.reason === "blocked_runtime_changed")));
}

/**
 * The same managed conversation, for keeping already displayed turns across a transient
 * check. The harness is part of the identity: the same nonce and generation under another
 * harness is another conversation, while an unknown session id during a transient check
 * does not prove a change.
 */
export function sameManagedSession(a: ManagedSessionIdentity | undefined, b: ManagedSessionIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.id === null || b.id === null || a.generation === null || b.generation === null) return false;
  if (a.harness === null || b.harness === null || a.harness !== b.harness) return false;
  return a.id === b.id && a.generation === b.generation
    && (a.session_id === null || b.session_id === null || a.session_id === b.session_id);
}
