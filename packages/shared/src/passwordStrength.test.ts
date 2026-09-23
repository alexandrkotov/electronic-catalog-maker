import { describe, expect, test } from "bun:test";
import { PROTECT_MIN_PASSWORD_LENGTH, passwordStrength } from "./passwordStrength.js";

describe("passwordStrength", () => {
  test("empty and too-short passwords", () => {
    expect(passwordStrength("")).toBe("empty");
    expect(passwordStrength("a1B!")).toBe("weak");
    expect(passwordStrength("x".repeat(PROTECT_MIN_PASSWORD_LENGTH - 1))).toBe("weak");
  });

  test("long but trivial passwords stay weak", () => {
    expect(passwordStrength("aaaaaaaaaaaaaaaa")).toBe("weak");
    expect(passwordStrength("abababababab")).toBe("weak");
    expect(passwordStrength("onlylowercase")).toBe("weak");
  });

  test("eight or more characters with some variety is fair", () => {
    expect(passwordStrength("gym2026x")).toBe("fair");
    expect(passwordStrength("Fitness1")).toBe("fair");
  });

  test("twelve mixed characters, or sixteen of anything varied, is strong", () => {
    expect(passwordStrength("Fitness-2026")).toBe("strong");
    expect(passwordStrength("correcthorsebattery")).toBe("strong");
  });

  test("counts characters, not UTF-16 units, and handles non-Latin letters", () => {
    expect(passwordStrength("🔑🔑🔑🔑🔑🔑🔑")).toBe("weak"); // 7 emoji: 14 units but 7 characters
    expect(passwordStrength("Ключ-2026")).toBe("fair");
  });
});
