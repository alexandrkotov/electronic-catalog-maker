import type { CatalogRow } from "./types.js";

/**
 * The rules of `catalog_mode = quiz`, kept free of DOM/DB so they can be
 * tested on their own. A quiz question is one image; its rows are the answer
 * options (the row's name is the option's text) and the hotspots on the image
 * are the same options drawn in place. Two row.extra keys drive it:
 *
 *   correct — "1"/"true"/"yes" marks a right answer. Any number of rows may be.
 *   need    — how many right answers the question asks for ("Name two ..."),
 *             a positive integer read from any row of the image (the largest
 *             wins), default 1 ("Name one ...").
 *
 * Answering ends the question at the first wrong pick (failed) or once `need`
 * right ones are picked (passed). Both keys are hidden from the table so they
 * don't give the answer away — see QUIZ_HIDDEN_EXTRA_KEYS.
 */
export const QUIZ_HIDDEN_EXTRA_KEYS = ["correct", "need"];

export function isCorrectRow(row: Pick<CatalogRow, "extra">): boolean {
  const v = row.extra.correct;
  if (typeof v !== "string") return false;
  return ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
}

export type QuizStatus = "open" | "passed" | "failed";

export interface QuestionState {
  /** True when the image has at least one correct row; images without one aren't questions. */
  isQuestion: boolean;
  status: QuizStatus;
  need: number;
  /** urls of rows to paint green: the ones picked and right, plus — once failed — every right one. */
  green: Set<string>;
  /** urls of picked wrong rows, to paint red. */
  red: Set<string>;
  /** Picked urls that were counted, in order (repeats and unknown urls dropped). */
  picked: string[];
}

export function evaluateQuestion(rows: Pick<CatalogRow, "url" | "extra">[], picks: readonly string[]): QuestionState {
  const correct = new Set(rows.filter(isCorrectRow).map((r) => r.url));
  const known = new Set(rows.map((r) => r.url));
  let need = 1;
  for (const r of rows) {
    const n = Number.parseInt(String(r.extra.need ?? ""), 10);
    if (Number.isFinite(n) && n > need) need = n;
  }
  need = Math.min(need, Math.max(correct.size, 1));

  const green = new Set<string>();
  const red = new Set<string>();
  const picked: string[] = [];
  let status: QuizStatus = "open";
  for (const url of picks) {
    if (status !== "open") break; // the question is settled — later clicks change nothing
    if (!known.has(url) || picked.includes(url)) continue;
    picked.push(url);
    if (correct.has(url)) {
      green.add(url);
      if (green.size >= need) status = "passed";
    } else {
      red.add(url);
      status = "failed";
    }
  }
  if (status === "failed") for (const url of correct) green.add(url);
  return { isQuestion: correct.size > 0, status, need, green, red, picked };
}

export interface QuizScore {
  total: number;
  answered: number;
  correct: number;
  /** Whole percent of `total` answered right; 0 when there are no questions. */
  percent: number;
  finished: boolean;
}

export function scoreQuiz(states: Iterable<QuestionState>): QuizScore {
  let total = 0;
  let answered = 0;
  let correct = 0;
  for (const s of states) {
    if (!s.isQuestion) continue;
    total++;
    if (s.status !== "open") answered++;
    if (s.status === "passed") correct++;
  }
  return { total, answered, correct, percent: total ? Math.round((correct / total) * 100) : 0, finished: total > 0 && answered === total };
}

/** Per-catalog storage key for saved answers, same identity scheme as the cart's (see cart.ts cartStorageKey). */
export function quizStorageKey(sourceName: string, catalogName: string): string {
  return `ecm-viewer-quiz:${sourceName}::${catalogName}`;
}

/** Saved picks per image id. Never throws: unavailable or corrupted storage just means starting over. */
export function loadQuizPicks(key: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, urls] of Object.entries(parsed)) {
        if (Array.isArray(urls) && urls.every((u) => typeof u === "string")) out.set(Number(id), urls);
      }
    }
  } catch {
    // fall through to an empty result
  }
  return out;
}

export function saveQuizPicks(key: string, picks: Map<number, string[]>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(picks)));
  } catch {
    // Answers still count for this session, just won't survive a reload.
  }
}
