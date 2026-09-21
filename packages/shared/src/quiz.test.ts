import { describe, expect, test } from "bun:test";
import { evaluateQuestion, isCorrectRow, scoreQuiz } from "./quiz.js";

const row = (url: string, extra: Record<string, string> = {}) => ({ url, extra });

describe("isCorrectRow", () => {
  test("accepts the usual truthy spellings, nothing else", () => {
    expect(isCorrectRow(row("a", { correct: "1" }))).toBe(true);
    expect(isCorrectRow(row("a", { correct: " True " }))).toBe(true);
    expect(isCorrectRow(row("a", { correct: "0" }))).toBe(false);
    expect(isCorrectRow(row("a"))).toBe(false);
  });
});

describe("evaluateQuestion", () => {
  const rows = [row("a"), row("b", { correct: "1" }), row("c"), row("d", { correct: "1" })];

  test("no picks: open, nothing painted", () => {
    const s = evaluateQuestion(rows, []);
    expect(s.status).toBe("open");
    expect(s.green.size + s.red.size).toBe(0);
  });

  test("need 1: a right pick settles it, other right rows stay unrevealed", () => {
    const s = evaluateQuestion(rows, ["b"]);
    expect(s.status).toBe("passed");
    expect([...s.green]).toEqual(["b"]);
  });

  test("a wrong pick fails and reveals every right row", () => {
    const s = evaluateQuestion(rows, ["a"]);
    expect(s.status).toBe("failed");
    expect([...s.red]).toEqual(["a"]);
    expect([...s.green].sort()).toEqual(["b", "d"]);
  });

  test("need 2: stays open after one right pick, passes after two", () => {
    const two = [row("a"), row("b", { correct: "1", need: "2" }), row("d", { correct: "1" })];
    expect(evaluateQuestion(two, ["b"]).status).toBe("open");
    expect(evaluateQuestion(two, ["b", "d"]).status).toBe("passed");
  });

  test("need 2: a wrong pick after one right one still fails", () => {
    const two = [row("a"), row("b", { correct: "1", need: "2" }), row("d", { correct: "1" })];
    const s = evaluateQuestion(two, ["b", "a"]);
    expect(s.status).toBe("failed");
    expect([...s.green].sort()).toEqual(["b", "d"]);
  });

  test("need is capped by the number of right rows", () => {
    expect(evaluateQuestion([row("a"), row("b", { correct: "1", need: "5" })], ["b"]).status).toBe("passed");
  });

  test("picks after the question is settled, repeats and unknown urls are ignored", () => {
    const s = evaluateQuestion(rows, ["b", "a", "zzz"]);
    expect(s.status).toBe("passed");
    expect(s.picked).toEqual(["b"]);
    expect(s.red.size).toBe(0);
    expect(evaluateQuestion(rows, ["zzz", "b", "b"]).picked).toEqual(["b"]);
  });

  test("an image with no right row is not a question", () => {
    expect(evaluateQuestion([row("a"), row("b")], []).isQuestion).toBe(false);
  });
});

describe("scoreQuiz", () => {
  const rows = [row("a"), row("b", { correct: "1" })];
  test("counts answered and correct, skips non-questions, reports finished", () => {
    const states = [evaluateQuestion(rows, ["b"]), evaluateQuestion(rows, ["a"]), evaluateQuestion(rows, []), evaluateQuestion([row("x")], [])];
    expect(scoreQuiz(states)).toEqual({ total: 3, answered: 2, correct: 1, percent: 33, finished: false });
    expect(scoreQuiz([evaluateQuestion(rows, ["b"])]).finished).toBe(true);
  });
  test("empty quiz is 0%, never finished", () => {
    expect(scoreQuiz([])).toEqual({ total: 0, answered: 0, correct: 0, percent: 0, finished: false });
  });
});
