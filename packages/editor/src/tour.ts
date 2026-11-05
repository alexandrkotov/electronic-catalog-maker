/**
 * Quick tour of the editor: the page is dimmed, one part of it at a time is
 * lit up and a card says what it is for; Next / Back / Skip, Esc closes.
 * Ported from Tapalog Reader's tour, with two differences the editor needs:
 *
 * - render() rebuilds the whole page on every change, so a step keeps its
 *   selector, not the element, and looks it up again on every placing;
 * - a step can light up several elements at once (Save with Undo and Redo)
 *   and carry a figure — a small drawing of what to do, for a step that
 *   is about a way of working rather than a single button.
 *
 * Texts come in already translated: the editor's dictionary test only reads
 * main.ts, so the keys stay there.
 */

export interface TourStep {
  /** CSS selector of what to light up; several elements light up together. A step with none of them shown (absent, display: none) is skipped; one scrolled away is scrolled to. */
  target: string;
  text: string;
  /** The text as markup instead (already escaped), for a step that shows a sign the way the page draws it. */
  textHtml?: string;
  /** Markup of a drawing shown under the text (built from the editor's own strings, already escaped). */
  figure?: string;
  /** A card this wide when there is room, for a step with a figure. */
  width?: number;
}

export interface TourLabels {
  step: (n: number, total: number) => string;
  next: string;
  back: string;
  skip: string;
  done: string;
}

const GAP = 10;
const MARGIN = 12;
const PAD = 4;

function visibleRect(node: Element): DOMRect | null {
  const r = node.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;
  return getComputedStyle(node).visibility === "hidden" ? null : r;
}

/** Shown at all: laid out with a size, not hidden (it may be scrolled out of view). */
function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** The box around every element of the step that is on screen, or null when none is. */
function targetRect(selector: string): DOMRect | null {
  const rects = [...document.querySelectorAll(selector)].map(visibleRect).filter((r): r is DOMRect => r !== null);
  if (!rects.length) return null;
  const left = Math.max(0, Math.min(...rects.map((r) => r.left)));
  const top = Math.max(0, Math.min(...rects.map((r) => r.top)));
  const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)));
  const bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)));
  return new DOMRect(left, top, right - left, bottom - top);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

let stopTour: (() => void) | null = null;

export function isTourOpen(): boolean {
  return stopTour !== null;
}

export function startTour(steps: TourStep[], labels: TourLabels, onClose?: () => void): void {
  stopTour?.();
  const items = steps.filter((s) => [...document.querySelectorAll(s.target)].some(isShown));
  if (!items.length) return;

  const blocker = node("div", "tour-blocker"); // nothing behind the tour can be clicked
  const hole = node("div", "tour-hole");
  const figure = node("div", "tour-figure");
  const text = node("p", "tour-text");
  const counter = node("span", "tour-count");
  const skip = node("button", "tour-skip", labels.skip);
  const back = node("button", "tour-back", labels.back);
  const next = node("button", "tour-next");
  for (const b of [skip, back, next]) b.type = "button";
  const head = node("div", "tour-head");
  head.append(counter, skip);
  const actions = node("div", "tour-actions");
  actions.append(back, next);
  const card = node("div", "tour-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  card.append(head, text, figure, actions);
  const before = document.activeElement as HTMLElement | null;
  let index = 0;

  const place = () => {
    const step = items[index]!;
    const r = targetRect(step.target);
    if (!r) return; // gone for a moment (a redraw): keep the last place
    Object.assign(hole.style, { left: `${r.left - PAD}px`, top: `${r.top - PAD}px`, width: `${r.width + 2 * PAD}px`, height: `${r.height + 2 * PAD}px` });
    const width = Math.min(step.width ?? 340, innerWidth - 2 * MARGIN);
    card.style.width = `${width}px`;
    const height = card.offsetHeight;
    const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max));
    let left = clamp(r.left, innerWidth - width - MARGIN);
    let top = r.bottom + PAD + GAP; // below, else above, else beside, else over the bottom of it
    if (top + height > innerHeight - MARGIN) top = r.top - PAD - GAP - height;
    if (top < MARGIN) {
      if (r.left - PAD - GAP - width >= MARGIN) left = r.left - PAD - GAP - width;
      else if (r.right + PAD + GAP + width + MARGIN <= innerWidth) left = r.right + PAD + GAP;
      top = clamp(r.top, innerHeight - height - MARGIN);
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
  };

  const show = () => {
    const step = items[index]!;
    [...document.querySelectorAll(step.target)].find(isShown)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    figure.innerHTML = step.figure ?? "";
    figure.hidden = !step.figure;
    if (step.textHtml) text.innerHTML = step.textHtml;
    else text.textContent = step.text;
    counter.textContent = labels.step(index + 1, items.length);
    back.hidden = index === 0;
    next.textContent = index === items.length - 1 ? labels.done : labels.next;
    place();
    next.focus();
  };

  const close = () => {
    stopTour = null;
    clearInterval(follow);
    removeEventListener("resize", place);
    removeEventListener("keydown", onKey, true);
    blocker.remove();
    hole.remove();
    card.remove();
    before?.focus();
    onClose?.();
  };
  // Keys go to the card only: Ctrl+Z or Ctrl+S must not change the catalog behind it.
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key === "ArrowRight" && !next.hidden) next.click();
    else if (event.key === "ArrowLeft" && !back.hidden) back.click();
    if (event.key === "Tab" || ((event.key === "Enter" || event.key === " ") && card.contains(event.target as Node))) {
      event.stopImmediatePropagation(); // the card's own buttons
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  next.addEventListener("click", () => (index === items.length - 1 ? close() : (index++, show())));
  back.addEventListener("click", () => (index--, show()));
  skip.addEventListener("click", close);
  addEventListener("resize", place);
  addEventListener("keydown", onKey, true);
  const follow = setInterval(place, 200); // a redraw can move the lit part (a status line, a collaborator's change)
  document.body.append(blocker, hole, card);
  stopTour = close;
  show();
}

/** A small card on the empty start screen of a first visit: the tour is offered once, never forced. */
export function offerTour(text: string, yesLabel: string, noLabel: string, onAnswer: (go: boolean) => void): void {
  document.querySelector(".tour-offer")?.remove();
  const card = node("div", "tour-offer");
  card.setAttribute("role", "dialog");
  const yes = node("button", "tour-next", yesLabel);
  const no = node("button", "tour-back", noLabel);
  for (const b of [yes, no]) b.type = "button";
  const answer = (go: boolean) => {
    card.remove();
    onAnswer(go);
  };
  yes.addEventListener("click", () => answer(true));
  no.addEventListener("click", () => answer(false));
  const actions = node("div", "tour-actions");
  actions.append(no, yes);
  card.append(node("p", "tour-text", text), actions);
  document.body.append(card);
}

/** Takes the offer away without an answer (the person started working instead). */
export function withdrawTourOffer(): boolean {
  const card = document.querySelector(".tour-offer");
  card?.remove();
  return card !== null;
}
