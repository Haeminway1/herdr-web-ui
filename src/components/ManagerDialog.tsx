import { useEffect, useRef, useState, type MouseEvent } from "react";
import { X } from "lucide-react";
import type { AgentKind, ManagerStatus } from "../../shared/protocol.ts";
import { fetchAgentKinds, fetchManager, startManager, stopManager } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";

export function ManagerDialog({ onClose, onOpenPane }: { onClose(): void; onOpenPane(paneId: string): Promise<void> }) {
  const t = useT();
  const firstField = useRef<HTMLSelectElement>(null);
  const [status, setStatus] = useState<ManagerStatus | null>(null);
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchManager(), fetchAgentKinds("local")]).then(([next, kinds]) => {
      if (cancelled) return;
      setStatus(next);
      setAgents(kinds.filter((kind) => kind.kind === "codex" || kind.kind === "claude"));
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    window.requestAnimationFrame(() => firstField.current?.focus());
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  const refresh = async (): Promise<ManagerStatus> => {
    const next = await fetchManager();
    setStatus(next);
    return next;
  };
  const run = async (action: () => Promise<ManagerStatus>, openPane = false): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      setStatus(result);
      if (result.message && result.state !== "running" && result.state !== "stopped") setError(result.message);
      if (openPane && result.state === "running") {
        if (!result.pane_id || !result.workspace_id) throw new Error(t("Manager pane is unavailable"));
        await onOpenPane(result.pane_id);
        onClose();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      try { await refresh(); } catch { /* retain the actionable failure above */ }
    } finally {
      setPending(false);
    }
  };
  const open = (): void => {
    const expected = status;
    if (!expected?.workspace_id || !expected.pane_id) return;
    void run(async () => {
      const current = await fetchManager();
      if (current.state !== "running" || current.workspace_id !== expected.workspace_id || current.pane_id !== expected.pane_id) {
        setStatus(current);
        throw new Error(t("Manager identity changed. Refresh and try again."));
      }
      return current;
    }, true);
  };
  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };
  const canStop = status?.state === "running" && !!status.workspace_id && !!status.pane_id;
  const stateLabels: Record<ManagerStatus["state"], string> = {
    absent: t("absent"), running: t("running"), unavailable: t("unavailable"),
    ambiguous: t("ambiguous"), starting: t("starting"), stopped: t("stopped"),
  };

  return <div className="modal-scrim" onMouseDown={closeFromScrim}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="manager-title">
      <header className="modal-header">
        <h2 className="modal-title" id="manager-title">{t("Manager")}</h2>
        <button type="button" className="icon-button" aria-label={t("Close manager dialog")} disabled={pending} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="modal-body">
        <p className="field-hint">{t("Manager runs only on this PC. Remote PC managers are not supported.")}</p>
        <p className="field-hint">{t("Starting the manager uses your existing agent with its normal permissions and may incur model usage charges. No new paid API is connected.")}</p>
        <p role="status">{status ? t("Manager status: {state}", { state: stateLabels[status.state] }) : t("Loading manager status…")}</p>
        {status?.message && <p className="field-hint" role="status">{status.message}</p>}
        {status?.state === "running" && <p className="field-hint">{t("Manager workspace: {id}", { id: status.workspace_id ?? "?" })}</p>}
        {error && <p role="alert" className="field-hint">{error}</p>}
        {(status?.state === "absent" || status?.state === "stopped") && <>
          <label className="field"><span className="field-label">{t("Agent")}</span>
            <select ref={firstField} className="input" value={agent} disabled={pending} onChange={(event) => { setAgent(event.target.value); setEffort(""); }}>
              <option value="">{t("Select agent")}</option>
              {agents.map((kind) => <option key={kind.kind} value={kind.kind}>{kind.label}</option>)}
            </select>
          </label>
          {agents.length === 0 && <p className="field-hint">{t("No supported agents available from Herdr")}</p>}
          <label className="field"><span className="field-label">{t("Model (optional)")}</span><input className="input" value={model} disabled={pending} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="field"><span className="field-label">{t("Effort (optional)")}</span><select className="input" value={effort} disabled={pending || !agent} onChange={(event) => setEffort(event.target.value)}>
            <option value="">{t("Default")}</option>
            {(agent === "codex" ? ["minimal", "low", "medium", "high", "xhigh"] : agent === "claude" ? ["low", "medium", "high"] : []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
          </select></label>
        </>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Dismiss")}</button>
        {status?.state === "running" && <>
          <button type="button" className="btn" disabled={pending || !canStop} onClick={() => void run(() => stopManager(status.workspace_id!, status.pane_id!))}>{t("Stop manager")}</button>
          <button type="button" className="btn btn-primary" disabled={pending || !canStop} onClick={open}>{t("Open manager")}</button>
        </>}
        {(status?.state === "absent" || status?.state === "stopped") && <button type="button" className="btn btn-primary" disabled={pending || !agent} onClick={() => void run(() => startManager({ agent, ...(model.trim() ? { model: model.trim() } : {}), ...(effort.trim() ? { effort: effort.trim() } : {}) }), true)}>{t(pending ? "Starting…" : "Start manager")}</button>}
        <button type="button" className="btn" disabled={pending} onClick={() => void run(refresh)}>{t("Refresh")}</button>
      </footer>
    </div>
  </div>;
}
