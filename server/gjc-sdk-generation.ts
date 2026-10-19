import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { GjcSdkLookupError, lookupExecutionError } from "./gjc-sdk-error.ts";

export interface GjcSdkGenerationObserver {
  generationStatus(sessionId: string, generation: number): Promise<{ readonly status: string }>;
}

type ObserverConstructor = new (options: { agentDir: string; observer: true }) => GjcSdkGenerationObserver;
const observers = new Map<string, Promise<GjcSdkGenerationObserver>>();

function observerFor(agentDir: string): Promise<GjcSdkGenerationObserver> {
  let observer = observers.get(agentDir);
  if (!observer) {
    observer = (async () => {
      const cli = Bun.which("gjc");
      if (!cli) throw new Error("GJC SDK unavailable");
      // Resolve the installed CLI's supported public SDK, never a guessed private
      // index/endpoint path. This observer is not started or attached to a session.
      const modulePath = Bun.resolveSync("@gajae-code/coding-agent/sdk", dirname(realpathSync(cli)));
      const sdk = await import(modulePath) as { router?: { SessionRouter?: ObserverConstructor } };
      const Observer = sdk.router?.SessionRouter;
      if (typeof Observer !== "function") throw new Error("GJC generation API unavailable");
      return new Observer({ agentDir, observer: true });
    })();
    observers.set(agentDir, observer);
    void observer.catch(() => { if (observers.get(agentDir) === observer) observers.delete(agentDir); });
  }
  return observer;
}

/** A cached broker row is a candidate, never current authority after /new or retirement. */
export async function gjcSdkGenerationCurrent(
  agentDir: string,
  sessionId: string,
  generation: number,
  observer: GjcSdkGenerationObserver | Promise<GjcSdkGenerationObserver> = observerFor(agentDir),
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(observer).then(async (current) => (await current.generationStatus(sessionId, generation)).status === "current"),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), 2_000); }),
    ]);
  }
  catch (error) { throw lookupExecutionError(error); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
