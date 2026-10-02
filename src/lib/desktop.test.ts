import { afterEach, describe, expect, it } from "bun:test";
import { composerFileName, desktopFileNames, desktopNotify, desktopSelections, desktopShowsAlerts, shellFileName, type DesktopNotice, type DesktopTarget } from "./desktop.ts";
import { notificationTargets } from "./notificationTarget.ts";

const host = globalThis as { window?: unknown };
const hadWindow = "window" in host;
const previousWindow = host.window;

function withShell(shell: unknown): void {
  host.window = { herdrDesktop: shell };
}

afterEach(() => {
  if (hadWindow) host.window = previousWindow;
  else delete host.window;
});

const file = (name: string) => new File(["x"], name);
const notice: DesktopNotice = { title: "pc · api", body: "waiting for your input", tag: "herdr-pane-p1", pane_id: "p1", machine_id: "local" };

describe("desktop shell", () => {
  it("is absent in a browser: nothing named, nothing shown, push tried as before", () => {
    withShell(undefined);
    expect(desktopShowsAlerts()).toBe(false);
    expect(desktopNotify(notice)).toBe(false);
    expect(desktopFileNames([file("a.pdf")])).toBeNull();
    expect(desktopSelections()).toBeUndefined();
  });

  it("shows notices through the shell", () => {
    const shown: DesktopNotice[] = [];
    withShell({ notify: (n: DesktopNotice) => shown.push(n) });
    expect(desktopShowsAlerts()).toBe(true);
    expect(desktopNotify(notice)).toBe(true);
    expect(shown).toEqual([notice]);
  });

  it("names every file or none: anything odd uploads them as a browser would", () => {
    withShell({ nameFiles: (files: File[]) => files.map((f) => `laptop:C:/Users/me/${f.name}`) });
    expect(desktopFileNames([file("a.pdf"), file("b c.png")])).toEqual(["laptop:C:/Users/me/a.pdf", "laptop:C:/Users/me/b c.png"]);
    expect(desktopFileNames([])).toBeNull();
    for (const nameFiles of [
      () => null,
      () => ["only one"],
      () => ["", "x"],
      () => ["a\nrm -rf", "x"],
      () => [1, 2],
      () => { throw new Error("no path"); },
    ]) {
      withShell({ nameFiles });
      expect(desktopFileNames([file("a"), file("b")])).toBeNull();
    }
  });

  it("brings a notification click to the app as the service worker's messages do", () => {
    let click!: (target: DesktopTarget) => void;
    withShell({ onSelectPane: (listener: (target: DesktopTarget) => void) => { click = listener; } });
    const subscribe = notificationTargets(undefined, desktopSelections());
    const selected: unknown[] = [];
    subscribe((target) => selected.push(target));
    click({ machine_id: "laptop", pane_id: "w1:p2" });
    click({ pane_id: "w1:p3" } as DesktopTarget);
    click({ machine_id: "local" } as DesktopTarget);
    expect(selected).toEqual([{ machine_id: "laptop", pane_id: "w1:p2" }, { machine_id: "local", pane_id: "w1:p3" }]);
  });
});

describe("file names as text", () => {
  it("quotes a name with a space for the message box, and every name for a shell", () => {
    expect(composerFileName("laptop:C:/a.pdf")).toBe("laptop:C:/a.pdf");
    expect(composerFileName('/home/me/my "draft".md')).toBe('"/home/me/my \\"draft\\".md"');
    expect(shellFileName("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
  });
});
