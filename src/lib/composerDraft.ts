/** Drafts and in-flight sends belong to their pane, even while its composer is unmounted. */
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** `unconfirmed`: the draft holds a message a page closed before the pane said whether it took it */
interface Draft { text: string; sending: boolean; unconfirmed?: true }
/** A dispatched message waits here, beside its draft, until the pane takes or refuses it. */
const UNCONFIRMED = ":unconfirmed";
export class ComposerDraftStore {
  private drafts = new Map<string, Draft>();
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  /** the text each pending send carries, whether the draft stopped extending it meanwhile, and whether it left the draft */
  private pending = new Map<string, { sent: string; edited: boolean; dispatched?: true }>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => DraftStorage = () => window.localStorage) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) {
      let text: string | null = null;
      let unconfirmed: string | null = null;
      try { text = this.storage().getItem(key); unconfirmed = this.storage().getItem(key + UNCONFIRMED); } catch { /* private mode */ }
      this.saved.set(key, text);
      draft = { text: text ?? "", sending: false };
      this.drafts.set(key, draft);
      // a page that closed before its send was answered: the message goes back in front of the draft, marked
      if (unconfirmed !== null) {
        this.set(key, text ? `${unconfirmed}\n${text}` : unconfirmed);
        this.forget(key);
        draft = { ...this.drafts.get(key)!, unconfirmed: true };
        this.drafts.set(key, draft);
      }
    }
    return draft;
  }
  private forget(key: string): void {
    try { this.storage().removeItem(key + UNCONFIRMED); } catch { /* nothing was kept */ }
  }
  refresh(key: string): void {
    if (this.unsaved.has(key)) return;
    const draft = this.read(key);
    try {
      const text = this.storage().getItem(key);
      if (text === this.saved.get(key)) return;
      // another tab changed it while a send was on its way: the same rule as a local edit
      const pending = this.pending.get(key);
      if (pending && !(text ?? "").startsWith(pending.sent)) pending.edited = true;
      this.saved.set(key, text);
      this.drafts.set(key, { ...draft, text: text ?? "" });
      this.notify();
    } catch { /* retain the in-memory draft */ }
  }
  set(key: string, value: string | ((previous: string) => string)): void {
    const draft = this.read(key);
    const text = typeof value === "string" ? value : value(draft.text);
    // cleared and retyped while on its way, a draft can end up starting with the sent text
    // again: once it stopped extending it, the whole of it is the user's own
    const pending = this.pending.get(key);
    if (pending && !text.startsWith(pending.sent)) pending.edited = true;
    this.drafts.set(key, { ...draft, text });
    try {
      if (text) this.storage().setItem(key, text);
      else this.storage().removeItem(key);
      this.saved.set(key, text || null);
      this.unsaved.delete(key);
    } catch { this.unsaved.add(key); }
    this.notify();
  }
  /** `sent`: the draft text this send carries, settled once it is acknowledged */
  begin(key: string, sent?: string): boolean {
    const draft = this.read(key);
    if (draft.sending) return false;
    if (sent !== undefined) this.pending.set(key, { sent, edited: false });
    this.drafts.set(key, { text: draft.text, sending: true });
    this.notify();
    return true;
  }
  /**
   * Sends at once: the sent text leaves the draft now (the chat shows it as sending), so the box
   * is free while the pane takes it. False while another send of this draft is on its way.
   */
  dispatch(key: string, sent: string): boolean {
    if (!this.begin(key, sent)) return false;
    // kept apart from the draft until the pane answers, so a reload cannot lose it
    try { this.storage().setItem(key + UNCONFIRMED, sent); } catch { /* only memory holds it */ }
    const current = this.read(key).text;
    this.set(key, current.startsWith(sent) ? current.slice(sent.length) : current);
    // what is in the box from now on is new, not the sent text edited
    this.pending.set(key, { sent, edited: false, dispatched: true });
    return true;
  }
  /** A dispatched send failed: its text goes back in front of whatever was typed since. */
  restore(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    const current = this.read(key).text;
    this.set(key, current === "" ? pending.sent : `${pending.sent}\n${current}`);
    if (pending.dispatched) this.forget(key);
  }
  /** The send is answered: taken, or already put back by `restore`. */
  end(key: string): void {
    if (this.pending.get(key)?.dispatched) this.forget(key);
    this.pending.delete(key);
    this.drafts.set(key, { ...this.read(key), sending: false });
    this.notify();
  }
  /** Remove only the acknowledged prefix; edits within the sent text stay unsent. */
  settle(key: string, sent: string): { text: string; edited: boolean } {
    this.refresh(key);
    const current = this.read(key).text;
    const editedMeanwhile = this.pending.get(key)?.edited === true;
    this.pending.delete(key);
    const edited = editedMeanwhile || current !== sent && !current.startsWith(sent);
    const text = edited ? current : current.slice(sent.length);
    this.set(key, text);
    return { text, edited };
  }
}
export const composerDrafts = new ComposerDraftStore();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key?.startsWith("herdr-web-ui:composer-draft:") && !event.key.endsWith(UNCONFIRMED)) composerDrafts.refresh(event.key);
});
