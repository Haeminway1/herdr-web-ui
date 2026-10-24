import type { ManagedSessionIdentity } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** Identity readiness is separate from the engine's working/idle status. */
export function ManagedSessionStatus({ identity, badge = false }: { identity: ManagedSessionIdentity; badge?: boolean }) {
  const t = useT();
  const readOnly = identity.state === "blocked" && identity.readable === true;
  const text = identity.state === "ready" ? t("Session identified")
    : readOnly ? t("Showing saved conversation — read-only while the managed session recovers ({reason})", { reason: identity.reason ?? "blocked_runtime_changed" })
      : identity.state === "identity_pending" ? t("Waiting for managed session identity")
        : t("Managed session blocked: {reason}", { reason: identity.reason ?? "blocked_record_state" });
  const short = identity.state === "ready" ? t("Session identified")
    : readOnly ? t("Read-only chat")
      : identity.state === "identity_pending" ? t("Waiting for identity") : t("Session blocked");
  const data = { "data-managed-state": identity.state, ...(readOnly ? { "data-managed-readable": "true" } : {}) };
  return badge
    ? <span className={`badge badge-${identity.state === "blocked" && !readOnly ? "blocked" : "unknown"}`} {...data} title={text}>{short}</span>
    : <p className="chat-inline-state" role="status" {...data}>{text}</p>;
}
