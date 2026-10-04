import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Terminal } from "lucide-react";
import type { Machine } from "../../shared/machines.ts";

import { attentionGroups, isUnread, type AttentionEntry } from "../lib/attention.ts";
import { dashboardProjects, type DashboardProject } from "../lib/dashboardProjects.ts";
import { useMachineApi, MachineContext } from "../lib/machineContext.tsx";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, RestoreErrorBadge } from "./Sidebar.tsx";
import { STATE_WORD } from "./MachineSidebar.tsx";
import "./DashboardSidebar.css";

interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void; renderMachineControls(machine: Machine): React.ReactNode }

export function DashboardSidebar(props: Props) {
  const t = useT();
  const groups = attentionGroups(props.machines);
  const [workingOpen, setWorkingOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState<"Needs you" | "To read" | null>(null);
  const total = groups.needsInput.length + groups.toRead.length + groups.working.length;
  const projects = dashboardProjects(props.machines);
  return <div className="dashboard-list">
    <div className="dashboard-attention">
      <h2>{t("Now")} <span className="pill">{total}</span></h2>
      <div className="dashboard-attention-entries">
        {([ ["Needs you", groups.needsInput], ["To read", groups.toRead] ] as const).map(([title, entries]) => <section key={title} aria-label={t(title)}><h3 className={title === "Needs you" ? "dashboard-needs-input" : "dashboard-to-read"}>{t(title === "Needs you" ? "Needs response" : "New results")} <span className="pill">{entries.length}</span>{entries.length > 1 && <button type="button" className="dashboard-attention-more" aria-label={`${t(title)} (${entries.length - 1})`} aria-expanded={moreOpen === title} onClick={() => setMoreOpen(moreOpen === title ? null : title)}><MoreHorizontal aria-hidden="true" /></button>}</h3>{entries.length > 0 && <ul>{entries.slice(0, moreOpen === title ? undefined : 1).map((entry) => <AttentionRow key={JSON.stringify([entry.machine.id, entry.pane.pane_id])} entry={entry} {...props} />)}</ul>}</section>)}
        <section aria-label={t("Working")}><h3><button type="button" aria-expanded={workingOpen} onClick={() => setWorkingOpen(!workingOpen)}>{t("Working")} <span className="pill">{groups.working.length}</span>{workingOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button></h3>{workingOpen && <ul>{groups.working.map((entry) => <AttentionRow key={JSON.stringify([entry.machine.id, entry.pane.pane_id])} entry={entry} {...props} />)}</ul>}</section>
      </div>
    </div>
    <div className="dashboard-projects"><div className="dashboard-projects-heading"><h2>{t("My projects")} <span className="pill">{projects.length}</span></h2>{props.machines.length === 1 && <span className="dashboard-single-machine">▣ {props.machines[0]?.name}</span>}</div><nav aria-label={t("Herdr workspaces")}>
      {props.machines.map((machine) => <section className="dashboard-machine" key={machine.id} aria-label={t("PC {name}", { name: machine.name })}>
        <header className={props.machines.length === 1 ? "dashboard-single-machine-header" : ""}><span className={`machine-dot is-${machine.state}`} aria-hidden="true" /><strong>{machine.name}</strong><span className="dashboard-machine-state">{machine.state === "connected" ? "" : t(STATE_WORD[machine.state])}</span><button type="button" className="dashboard-machine-new" disabled={machine.state !== "connected"} aria-label={t("New session on {name}", { name: machine.name })} title={t("New session on {name}", { name: machine.name })} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button></header>
        {props.renderMachineControls(machine)}
        <div className="dashboard-grid">{dashboardProjects([machine]).map((project) => <MachineContext.Provider key={project.key} value={machine.id}><ProjectCard project={project} selected={props.selectedMachineId === machine.id ? props.selectedPaneId : null} onSelect={props.onSelect} /></MachineContext.Provider>)}</div>
      </section>)}
      {!props.machines.length && <p className="tree-state" role="status">{t("Loading PCs…")}</p>}
    </nav></div>
  </div>;
}

function AttentionRow({ entry, selectedMachineId, selectedPaneId, onSelect }: Props & { entry: AttentionEntry }) {
  const { machine, pane, workspace } = entry;
  const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
  return <li><button type="button" className={selected ? "is-selected" : ""} aria-current={selected ? "true" : undefined} onClick={() => onSelect(machine.id, pane.pane_id)}>{pane.agent ? <AgentMark agent={pane.agent} size={18} /> : <Terminal aria-hidden="true" />}<span><strong>{workspace.label}</strong><small>{pane.attention?.preview || `${machine.name} · ${displayPaneTitle(pane)}`}</small></span><ChevronRight aria-hidden="true" /></button></li>;
}

function ProjectCard({ project, selected, onSelect }: { project: DashboardProject; selected: string | null; onSelect(machineId: string, paneId: string): void }) {
  const t = useT();
  const { renamePane, renameWorkspace, closePane } = useMachineApi();
  const { machine, workspace, panes, online } = project;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<"workspace" | string | null>(null);
  const [label, setLabel] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const begin = (id: "workspace" | string, value: string) => { setEditing(id); setLabel(value); };
  const save = (id: "workspace" | string) => {
    setEditing(null);
    void (id === "workspace" ? renameWorkspace(workspace.workspace_id, label.trim()) : renamePane(id, label.trim())).catch((reason: unknown) => setError(t("Rename failed: {reason}", { reason: String(reason) })));
  };
  const close = (id: string) => {
    if (armed !== id) { setArmed(id); if (timer.current !== null) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setArmed(null), 3000); return; }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setArmed(null);
    void closePane(id).catch((reason: unknown) => setError(t("Close failed: {reason}", { reason: String(reason) })));
  };
  const active = panes.some((pane) => pane.pane_id === selected);
  const primary = panes[0];
  const restoreErrors = panes.filter((pane) => pane.restore_error);
  const status = (pane: typeof primary) => pane?.agent ? t(knownStatus(pane.agent_status) === "working" ? "Working" : knownStatus(pane.agent_status) === "blocked" ? "Needs response" : STATUS_WORD[knownStatus(pane.agent_status)]) : t("Terminal");
  return <article className={`dashboard-card${active ? " is-selected" : ""}${online ? "" : " is-offline"}`}>
    <div className="dashboard-card-top">
      {editing === "workspace" ? <input className="input" autoFocus aria-label={t("Workspace name")} value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") save("workspace"); if (event.key === "Escape") setEditing(null); }} /> : <button type="button" className="dashboard-card-main" disabled={!primary || (!online && panes.length === 1)} aria-current={active ? "true" : undefined} aria-expanded={panes.length > 1 ? expanded : undefined} onClick={() => { if (!primary) return; if (panes.length === 1) onSelect(machine.id, primary.pane_id); else setExpanded(!expanded); }} title={workspace.label}><strong>{workspace.label}</strong></button>}
      {online && <details className="dashboard-card-menu"><summary aria-label={t("Manage {name}", { name: workspace.label })}><MoreHorizontal aria-hidden="true" /></summary><div className="dashboard-card-menu-items"><button type="button" onClick={() => begin("workspace", workspace.label)}>{t("Rename workspace {name}", { name: workspace.label })}</button>{panes.map((pane) => <div key={pane.pane_id}><button type="button" onClick={() => begin(pane.pane_id, pane.label ?? "")}>{t("Rename {title}", { title: displayPaneTitle(pane) })}</button><button type="button" className={armed === pane.pane_id ? "is-armed" : ""} onClick={() => close(pane.pane_id)}>{t(armed === pane.pane_id ? "Confirm close {title}" : "Close {title}", { title: displayPaneTitle(pane) })}</button></div>)}</div></details>}
    </div>
    <div className="dashboard-card-meta"><span className="dashboard-card-agent">{primary && (primary.agent ? <AgentMark agent={primary.agent} size={13} /> : <Terminal aria-hidden="true" />)}<span>{primary ? primary.agent ? primary.agent === "gjc" ? "GJC" : primary.agent.charAt(0).toUpperCase() + primary.agent.slice(1) : t("Terminal") : ""}</span></span><span className={`dashboard-card-status${primary?.restore_error ? " is-error" : primary?.agent_status ? ` is-${knownStatus(primary.agent_status)}` : ""}`}>{!online ? t(STATE_WORD[machine.state]) : primary ? primary.restore_error ? <RestoreErrorBadge reason={primary.restore_error} /> : status(primary) : t("No workspaces yet")}</span>{restoreErrors.length > 0 && (panes.length > 1 || !online) && <span className="dashboard-restore-count" title={restoreErrors.map((pane) => `${displayPaneTitle(pane)}: ${pane.restore_error}`).join("\n")}><RestoreErrorBadge reason={restoreErrors.map((pane) => pane.restore_error).join("\n")} />{panes.length > 1 && <span> {restoreErrors.length}</span>}</span>}{online && panes.some(isUnread) && <span className="dashboard-unread" aria-label={t("To read")}>●</span>}{panes.length > 1 && <span>{panes.length}</span>}</div>
    {online && panes.length === 1 && editing === primary?.pane_id && <input className="input" autoFocus aria-label={t("Pane name")} value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") save(primary.pane_id); if (event.key === "Escape") setEditing(null); }} />}
    {expanded && panes.length > 1 && <ul className="dashboard-panes">{panes.map((pane) => <li key={pane.pane_id}><button type="button" disabled={!online} aria-current={selected === pane.pane_id ? "true" : undefined} onClick={() => onSelect(machine.id, pane.pane_id)}>{pane.agent ? <AgentMark agent={pane.agent} size={18} /> : <Terminal aria-hidden="true" />}<span>{displayPaneTitle(pane)}</span><small>{pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : online ? status(pane) : t(STATE_WORD[machine.state])}</small></button>{editing === pane.pane_id && <input className="input" autoFocus aria-label={t("Pane name")} value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") save(pane.pane_id); if (event.key === "Escape") setEditing(null); }} />}</li>)}</ul>}
    {error && <p role="alert" className="sidebar-inline-error">{error}</p>}
  </article>;
}
