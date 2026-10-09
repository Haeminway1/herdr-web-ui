import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { timeAgo, useT } from "../lib/i18n.ts";
import { attentionGroups, type AttentionEntry } from "../lib/attention.ts";
import { paneStatus } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
// fork: the inbox rows are the classic roster rows (ClassicSidebar.css), whatever sidebar is chosen
import "./ClassicSidebar.css";
import "./NeedsInput.css";

interface Props {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  onSelect(machineId: string, paneId: string): void;
}

const WORKING_OPEN_KEY = "herdr-web-ui:attention-working-open";

/**
 * The top of the pane list: what needs the user, across every PC. A question waiting, then an
 * answer not read yet, then work still going on (a count until opened). A pane already read, or
 * at rest, can be left alone and is not listed; with nothing to list the section is gone.
 */
export function AttentionInbox(props: Props) {
  const t = useT();
  const { needsInput, toRead, working } = attentionGroups(props.machines);
  const [workingOpen, setWorkingOpen] = useState(() => { try { return localStorage.getItem(WORKING_OPEN_KEY) === "1"; } catch { return false; } });
  // "3 min ago" goes stale while nothing else changes: a minute's tick keeps it honest
  const [, setTick] = useState(0);
  useEffect(() => {
    if (toRead.length === 0) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [toRead.length > 0]);
  const toggleWorking = () => {
    setWorkingOpen(!workingOpen);
    try { localStorage.setItem(WORKING_OPEN_KEY, workingOpen ? "0" : "1"); } catch {}
  };
  return <>
    <NeedsInput {...props} waiting={needsInput} />
    {toRead.length > 0 && <section className="needs-input attention-to-read" aria-label={t("To read")}>
      <h2 className="needs-input-heading">{t("To read")} <span className="pill">{toRead.length}</span></h2>
      <ul className="cl-pane-list">
        {toRead.map((entry) => <InboxRow key={paneStorageId(entry.machine.id, entry.pane.pane_id)} {...props} entry={entry} meta={<>
          <span className="attention-when">{timeAgo(entry.pane.attention!.finished_at!)}</span>
          <span className="cl-pane-subtitle" title={`${entry.machine.name} · ${entry.workspace.label}`}>{entry.pane.attention!.preview ?? `${entry.machine.name} · ${entry.workspace.label}`}</span>
        </>} />)}
      </ul>
    </section>}
    {working.length > 0 && <section className="needs-input attention-working" aria-label={t("Working")}>
      <h2 className="needs-input-heading">
        <button type="button" className="attention-toggle" aria-expanded={workingOpen} onClick={toggleWorking}>
          {workingOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          {t("Working")} <span className="pill">{working.length}</span>
        </button>
      </h2>
      {workingOpen && <ul className="cl-pane-list">
        {working.map((entry) => <InboxRow key={paneStorageId(entry.machine.id, entry.pane.pane_id)} {...props} entry={entry} />)}
      </ul>}
    </section>}
  </>;
}

/** Blocked panes on every PC: an agent asked something and waits for the answer. */
function NeedsInput({ waiting: list, ...props }: Props & { waiting: AttentionEntry[] }) {
  const t = useT();
  return <>
    <p className="visually-hidden" role="status">{t("Panes waiting for input: {n}", { n: list.length })}</p>
    {list.length > 0 && <section className="needs-input" aria-label={t("Needs you")}>
    <h2 className="needs-input-heading">{t("Needs you")} <span className="pill">{list.length}</span></h2>
    <ul className="cl-pane-list">
      {list.map((entry) => <InboxRow key={paneStorageId(entry.machine.id, entry.pane.pane_id)} {...props} entry={entry} />)}
    </ul>
    </section>}
  </>;
}

/** One pane, as compact as a roster row: mark, title, then its state (or `meta`) on line two. */
function InboxRow({ entry: { machine, pane, workspace }, selectedMachineId, selectedPaneId, onSelect, meta }: Props & { entry: AttentionEntry; meta?: ReactNode }) {
  const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
  return <li className={`needs-input-item${selected ? " is-selected" : ""}`}>
    <button type="button" className="cl-pane-select needs-input-select" aria-current={selected ? "true" : undefined} onClick={() => onSelect(machine.id, pane.pane_id)}>
      <span className="cl-agent-mark-holder"><AgentMark agent={pane.agent ?? ""} size={22} /></span>
      <span className="cl-pane-copy">
        <span className="cl-pane-title">{displayPaneTitle(pane)}</span>
        <span className="cl-pane-meta">{meta ?? <><StatusBadge status={paneStatus(pane)} /><span className="cl-pane-subtitle">{machine.name} · {workspace.label}</span></>}</span>
      </span>
    </button>
  </li>;
}
