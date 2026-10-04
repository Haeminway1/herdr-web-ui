/** Browser-only regression fixture, bundled by chat-history-browser-qa.ts. */
import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "../src/lib/settings.ts";
import { PaneTerminal } from "../src/components/PaneTerminal.tsx";
import { ChatView } from "../src/components/ChatView.tsx";
import { useWholeOutput } from "../src/lib/useWholeOutput.ts";
import { MachineContext } from "../src/lib/machineContext.tsx";
import "../src/styles.css";

declare global { interface Window { qa: { requests: { url: string; signal: AbortSignal; resolve: (text: string) => void; reject: () => void }[]; commits: string[][]; target: (url: string, scope: string) => void; chat: (pane: string, machine?: string) => void; select: (pane: string, machine: string, session: string) => void; refresh: () => void } } }
const nativeFetch = window.fetch;
window.qa = { requests: [], commits: [], target: () => {}, chat: () => {}, select: () => {}, refresh: () => {} };
window.fetch = (input, init) => {
  const url = String(input);
  if (!url.includes("tool-output") && !url.startsWith("/qa-output")) return nativeFetch(input, init);
  // Deliberately ignores cancellation: late transports must still be harmless.
  return new Promise((resolve, reject) => window.qa.requests.push({ url, signal: init!.signal as AbortSignal,
    resolve: (text) => resolve(new Response(text)), reject: () => reject(new Error("late failure")) }));
};
function Fixture() {
  const [target, setTarget] = useState({ url: "/qa-output?pane=a&ref=x", scope: "one" });
  const [pane, setPane] = useState("a");
  const [machine, setMachine] = useState("local");
  const [session, setSession] = useState("one");
  const [product, setProduct] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const output = useWholeOutput(target.url, target.scope);
  window.qa.target = (url, scope) => setTarget({ url, scope });
  window.qa.chat = (pane, machine = "local") => { setPane(pane); setMachine(machine); };
  window.qa.select = (pane, machine, nextSession) => { setProduct(true); setPane(pane); setMachine(machine); setSession(nextSession); };
  window.qa.refresh = () => setRefresh((value) => value + 1);
  return <><button id="fetch-output" onClick={() => { output.load(); output.load(); }}>Load output</button><output id="output">{output.state}:{output.text}</output>
    <div style={{ position: "relative", height: 600 }} data-session={session}><MachineContext.Provider value={machine}>{product ? <Profiler id="product-pane" onRender={() => {
      window.qa.commits.push(Array.from(document.querySelectorAll(".chat-turn"), (turn) => turn.textContent ?? ""));
    }}><PaneTerminal key={machine} paneId={pane} agent="codex" sessionIdentity={JSON.stringify(["codex", "id", session])} agentStatus={null} view="chat" terminalFontSize={14} terminalWheelSpeed={1} terminalFontFamily="" theme="dark" palette="amber" /></Profiler> : <ChatView key={machine} paneId={pane} refreshKey={refresh} connected={false} ended={false} agent={null} agentStatus={null} />}</MachineContext.Provider></div></>;
}
// xterm's viewport callbacks can outlive StrictMode's synthetic terminal unmount.
createRoot(document.getElementById("root")!).render(<SettingsProvider><Fixture /></SettingsProvider>);
