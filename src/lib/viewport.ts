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

/**
 * Focus is necessary, not sufficient: dismissal and hardware keyboards leave the
 * field focused. Prefer keyboard geometry where available; otherwise detect a
 * substantial viewport occlusion relative to the large CSS viewport or a remembered
 * unobstructed height. Comparing visualViewport with innerHeight alone misses browsers
 * that resize both. The relative cutoff excludes ordinary browser/status-bar insets;
 * Safari has no exact keyboard-visibility API, so small floating keyboards cannot be
 * inferred this way. xterm's automatically focused helper only counts in direct typing.
 */
const touch = window.matchMedia("(pointer: coarse)");
const keyboard = (navigator as Navigator & {
  virtualKeyboard?: EventTarget & { boundingRect: DOMRectReadOnly };
}).virtualKeyboard;
const largeViewport = document.createElement("div");
largeViewport.style.cssText = "position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;contain:strict";
largeViewport.setAttribute("aria-hidden", "true");
root.append(largeViewport);
// Width separates portrait and landscape without mistaking a shortened keyboard
// viewport for landscape. Keep the maximum through keyboard closing animations.
const unobstructedHeights = new Map<number, number>();
const typing = (element: Element | null): boolean =>
  (element instanceof HTMLTextAreaElement && (!element.classList.contains("xterm-helper-textarea") || element.closest("[data-direct-typing]") !== null))
  || (element instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(element.type))
  || (element instanceof HTMLElement && element.isContentEditable);
const syncKeyboard = (): void => {
  const width = window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const reference = Math.max(largeViewport.getBoundingClientRect().height, unobstructedHeights.get(width) ?? 0, window.innerHeight);
  const focused = touch.matches && typing(document.activeElement);
  const visible = focused && (keyboard
    ? keyboard.boundingRect.height > 0
    : !!viewport && viewport.scale === 1 && reference - height > reference * 0.2);
  if (!visible) unobstructedHeights.set(width, Math.max(reference, height, window.innerHeight));
  root.toggleAttribute("data-keyboard", visible);
  if (visible && viewport) root.style.setProperty("--app-height", `${Math.round(height)}px`);
  else root.style.removeProperty("--app-height");
  if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
};
viewport?.addEventListener("resize", syncKeyboard);
viewport?.addEventListener("scroll", syncKeyboard);
window.addEventListener("resize", syncKeyboard);
window.addEventListener("orientationchange", syncKeyboard);
touch.addEventListener("change", syncKeyboard);
keyboard?.addEventListener("geometrychange", syncKeyboard);
document.addEventListener("focusin", syncKeyboard);
// focus moving from one field to the next blurs first: read where it landed
document.addEventListener("focusout", () => window.setTimeout(syncKeyboard, 0));
// Switching xterm direct typing leaves its helper focused; observe the mode change.
new MutationObserver(syncKeyboard).observe(root, { attributes: true, subtree: true, attributeFilter: ["data-direct-typing"] });
syncKeyboard();
