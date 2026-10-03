import "./test-herdr.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { checkDroplet } from "./droplet-regression.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-island-browser-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), usage: new UsageService(undefined, []) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  await checkDroplet(browser, `http://127.0.0.1:${server.port}`);
} finally {
  await browser?.close();
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
