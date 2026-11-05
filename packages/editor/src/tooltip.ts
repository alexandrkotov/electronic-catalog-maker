/**
 * Hover hints in the editor's own colors. The browser draws `title` as a
 * black box whatever the theme, so every `title` that appears on the page is
 * moved to `data-tip` as soon as it appears (render() keeps writing them) and
 * drawn here instead: under the element, or above it near the bottom edge,
 * after a short pause; at once for a keyboard focus.
 *
 * The text stays available to screen readers: as the name of an element with
 * no words or numbers of its own (−, +, ×, ?), as its description otherwise.
 */

const DELAY_MS = 450;
const GAP = 6;
const MARGIN = 8;

let tip: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let timer: number | undefined;

function adopt(el: Element) {
  const text = el.getAttribute("title");
  if (text === null) return;
  el.removeAttribute("title");
  if (!text.trim()) return;
  (el as HTMLElement).dataset.tip = text;
  if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return;
  if (/[\p{L}\p{N}]/u.test(el.textContent ?? "")) el.setAttribute("aria-description", text);
  else el.setAttribute("aria-label", text);
}

function adoptAll(root: ParentNode) {
  if (root instanceof Element && root.hasAttribute("title")) adopt(root);
  root.querySelectorAll("[title]").forEach(adopt);
}

function hide() {
  window.clearTimeout(timer);
  timer = undefined;
  owner = null;
  if (tip) tip.hidden = true;
}

function show(el: HTMLElement) {
  if (!el.isConnected || !el.dataset.tip) return;
  tip ??= Object.assign(document.createElement("div"), { className: "ecm-tip", hidden: true });
  tip.setAttribute("role", "tooltip");
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - MARGIN));
  const below = r.bottom + GAP;
  const top = below + h > innerHeight - MARGIN ? Math.max(MARGIN, r.top - GAP - h) : below;
  Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
}

function schedule(el: HTMLElement, delay: number) {
  if (owner === el) return;
  hide();
  owner = el;
  timer = window.setTimeout(() => owner === el && show(el), delay);
}

export function installTooltips(root: HTMLElement = document.body) {
  adoptAll(root);
  new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "attributes") adopt(rec.target as Element);
      else rec.addedNodes.forEach((n) => n instanceof Element && adoptAll(n));
    }
    if (owner && !owner.isConnected) hide(); // redrawn under the pointer
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

  document.addEventListener("pointerover", (evt) => {
    if (evt.pointerType !== "mouse") return; // a tap has no hover; the hint would only cover the finger's target
    const el = (evt.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    if (el) schedule(el, DELAY_MS);
    else if (owner) hide();
  });
  document.addEventListener("pointerout", (evt) => {
    if (owner && !owner.contains(evt.relatedTarget as Node | null)) hide();
  });
  document.addEventListener("focusin", (evt) => {
    const el = (evt.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    if (el?.matches(":focus-visible")) schedule(el, 0);
  });
  document.addEventListener("focusout", () => hide());
  document.addEventListener("pointerdown", () => hide(), true);
  document.addEventListener("keydown", (evt) => evt.key === "Escape" && hide(), true);
  addEventListener("scroll", () => hide(), true);
  addEventListener("blur", () => hide());
}
