/*
 * Sizes the shell to the VISUAL viewport. When the soft keyboard opens, iOS
 * Safari shrinks window.visualViewport but leaves the layout viewport (and so
 * 100dvh) at full height and scrolls the page to reveal the focused textarea,
 * which drags the header off-screen and puts the key bar under the keyboard.
 * Publishing the visual height as --app-height (read by .app in styles.css)
 * and pinning the page at (0, 0) keeps header, terminal and key bar in view.
 * Chrome resizes the layout viewport itself (interactive-widget=resizes-content
 * in index.html), so there the same value changes nothing.
 *
 * Only the shell (.app) is pinned. The token gate sizes itself to the same height
 * and is otherwise a plain page: pinning it fought iOS scrolling the focused field
 * into view, and a second tap on the field (to paste) landed after the page jumped,
 * off the field, which dismissed the keyboard.
 *
 * The visual height is published only while the soft keyboard is up. An iPhone home
 * screen app (standalone, black-translucent status bar) reports a visual viewport
 * shorter than the screen with no keyboard at all, which left a band as tall as the
 * status bar under the composer. Without a keyboard the shell is 100dvh.
 */

const viewport = window.visualViewport;
const root = document.documentElement;

const syncHeight = (): void => {
  if (!viewport) return;
  if (root.hasAttribute("data-keyboard")) root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
  else root.style.removeProperty("--app-height");
  if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
};

if (viewport) {
  viewport.addEventListener("resize", syncHeight);
  viewport.addEventListener("scroll", syncHeight);
}

/**
 * Marks the page while a phone's soft keyboard is up, so the composer drops the
 * home-indicator space the keyboard covers (Composer.css) and the shell follows the
 * visual viewport. Viewport sizes do not tell: iOS Safari 26 resizes both viewports
 * with the keyboard. A touch device with a text field focused has its keyboard up -
 * except xterm's own hidden field, which the app focuses on its own and which raises
 * a keyboard only in direct typing (PaneTerminal marks that with data-direct-typing).
 */
const touch = window.matchMedia("(pointer: coarse)");
const typing = (element: Element | null): boolean =>
  (element instanceof HTMLTextAreaElement && (!element.classList.contains("xterm-helper-textarea") || element.closest("[data-direct-typing]") !== null))
  || (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(element.type))
  || (element instanceof HTMLElement && element.isContentEditable);
const syncKeyboard = (): void => {
  root.toggleAttribute("data-keyboard", touch.matches && typing(document.activeElement));
  syncHeight();
};
document.addEventListener("focusin", syncKeyboard);
// focus moving from one field to the next blurs first: read where it landed
document.addEventListener("focusout", () => window.setTimeout(syncKeyboard, 0));
syncKeyboard();
