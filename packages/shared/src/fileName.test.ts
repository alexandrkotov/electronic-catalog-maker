import { expect, test } from "bun:test";
import { catalogFileStem } from "./fileName.js";

test("keeps letters and digits of any script", () => {
  expect(catalogFileStem("Моя карта")).toBe("Моя_карта");
  expect(catalogFileStem("Каталог запчастин №2")).toBe("Каталог_запчастин_2");
  expect(catalogFileStem("Living Room")).toBe("Living_Room");
  expect(catalogFileStem("auto-spare_parts 2026")).toBe("auto-spare_parts_2026");
});

test("drops what a file name can't hold, without stray underscores", () => {
  expect(catalogFileStem('Nail techs: "Downtown"')).toBe("Nail_techs_Downtown");
  expect(catalogFileStem("a/b\\c?.ecatm")).toBe("a_b_c_ecatm");
});

test("falls back when nothing is left", () => {
  expect(catalogFileStem("")).toBe("catalog");
  expect(catalogFileStem("  …  ")).toBe("catalog");
  expect(catalogFileStem(undefined)).toBe("catalog");
});
