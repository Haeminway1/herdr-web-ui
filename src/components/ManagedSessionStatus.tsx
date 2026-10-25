import type { ManagedSessionIdentity } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** Identity readiness is separate from the engine's working/idle status. */
export function ManagedSessionStatus({ identity, badge = false }: { identity: ManagedSessionIdentity; badge?: boolean }) {
  const t = useT();
  const available = identity.state === "blocked" && identity.readable === true;
  const text = identity.state === "ready" ? t("Session identified")
    : available ? t("Conversation available; restarting the managed session is restricted ({reason})", { reason: identity.reason ?? "blocked_runtime_changed" })
      : identity.state === "identity_pending" ? t("Waiting for managed session identity")
        : t("Managed session blocked: {reason}", { reason: identity.reason ?? "blocked_record_state" });
  const short = identity.state === "ready" ? t("Session identified")
    : available ? t("Restart restricted")
      : identity.state === "identity_pending" ? t("Waiting for identity") : t("Session blocked");
  const data = { "data-managed-state": identity.state, ...(available ? { "data-managed-readable": "true" } : {}) };
  return badge
    ? <span className={`badge badge-${identity.state === "blocked" && !available ? "blocked" : "unknown"}`} {...data} title={text}>{short}</span>
    : <p className="chat-inline-state" role="status" {...data}>{text}</p>;
}
