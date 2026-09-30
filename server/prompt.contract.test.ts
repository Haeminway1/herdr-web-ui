import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * Answers to Claude's unnumbered menus (the folder-trust check among them), against the real
 * herdr server. Each pane runs a small menu under the name `claude`, reported as that agent:
 * ↑/↓ move its `❯` and Enter logs the row it lands on, so the test sees which row an answer
 * from the chat really picked.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-prompt-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const MENU = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { head, rows, drift } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  ...head, "", ...rows.map((row, index) => " " + (index === cursor ? "❯" : " ") + " " + row), "", " Enter to confirm · Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  // drift: a key typed in the pane at the same moment, one more row down
  if (/\\u001b[\\[O]B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1 + (drift ? 1 : 0));
  if (/\\u001b[\\[O]A/.test(data)) cursor = Math.max(0, cursor - 1);
  if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

interface Menu { pane: string; log: string }
let trust: Menu;
let guessed: Menu;
let drifting: Menu;

async function menu(label: string, head: string[], rows: string[], drift = false): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `herdr-web-ui-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  const spec = JSON.stringify({ head, rows, drift });
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "claude")}' '${join(root, "menu.js")}' '${log}' '${spec}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "blocked" });
  return { pane: created.root_pane.pane_id, log };
}

const base = () => `http://localhost:${server.port}`;
const chosen = (target: Menu) => readFileSync(target.log, "utf8").split("\n").filter(Boolean);

async function card(target: Menu): Promise<{ id: string; options: { label: string }[] }> {
  for (let i = 0; i < 100; i++) {
    const { prompt } = await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(target.pane)}`)).json() as { prompt: any };
    if (prompt) return prompt;
    await Bun.sleep(50);
  }
  throw new Error("no card within 5s");
}

async function answer(target: Menu, promptId: string, optionIndex: number): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: target.pane, prompt_id: promptId, option_index: optionIndex }),
  });
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "menu.js"), MENU);
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  trust = await menu("trust", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder"]);
  // the first row reaches past the rule, the only line off the rows, so the second reads as its wrapped tail
  guessed = await menu("guessed", ["─".repeat(35), " Trust?"], ["Yes, trust and enable all hooks", "Yes, trust this folder", "No, exit"]);
  drifting = await menu("drifting", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder", "Yes, and enable its hooks"], true);
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("answers to Claude's unnumbered menus", () => {
  it("moves the cursor to the row answered, then confirms it", async () => {
    const prompt = await card(trust);
    expect(prompt.options.map((option) => option.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    const response = await answer(trust, prompt.id, 1);
    expect(response.status).toBe(200);
    expect(chosen(trust)).toEqual(["Yes, I trust this folder"]);
  });

  it("confirms nothing when the cursor lands on a row the card does not show", async () => {
    const prompt = await card(guessed);
    // two rows merged into one: the card's second option is the menu's third row
    expect(prompt.options).toHaveLength(2);
    const response = await answer(guessed, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(guessed)).toEqual([]);
  });

  it("confirms nothing when the cursor moved past the row meanwhile", async () => {
    const prompt = await card(drifting);
    const response = await answer(drifting, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(drifting)).toEqual([]);
  });
});
