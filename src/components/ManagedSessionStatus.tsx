import type { ManagedSessionIdentity } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** Identity readiness is separate from the engine's working/idle status. */
export function ManagedSessionStatus({ identity, badge = false }: { identity: ManagedSessionIdentity; badge?: boolean }) {
  const t = useT();
  const text = identity.state === "ready" ? t("Session identified")
    : identity.state === "identity_pending" ? t("Waiting for managed session identity")
      : `${t("Managed session blocked")}${identity.reason === null ? "" : `: ${identity.reason}`}`;
  const short = identity.state === "ready" ? t("Session identified")
    : identity.state === "identity_pending" ? t("Waiting for identity") : t("Session blocked");
  return badge
    ? <span className={`badge badge-${identity.state === "blocked" ? "blocked" : "unknown"}`} data-managed-state={identity.state} title={text}>{short}</span>
    : <p className="chat-inline-state" role="status" data-managed-state={identity.state}>{text}</p>;
}
