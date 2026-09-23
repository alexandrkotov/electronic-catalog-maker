import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createEmptyCatalog, exportCatalog, initSqlite, openCatalog, readMeta } from "./db.js";
import {
  PROTECT_MAX_COVER_BYTES,
  ProtectedCatalogError,
  isProtectedCatalog,
  protectCatalog,
  readProtectedInfo,
  unlockCatalog,
} from "./protect.js";

// Low cost so the suite stays fast; the default (600k) is only checked for being applied.
const FAST = 1_000;

const plain = new TextEncoder().encode("SQLite format 3\0 pretend this is a catalog");
const cover = { mime: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) };

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ProtectedCatalogError) return e.code;
    throw e;
  }
  return "no-error";
}

describe("isProtectedCatalog", () => {
  test("tells a protected file from SQLite and junk", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "Shop", iterations: FAST });
    expect(isProtectedCatalog(sealed)).toBe(true);
    expect(isProtectedCatalog(plain)).toBe(false);
    expect(isProtectedCatalog(new Uint8Array(3))).toBe(false);
    expect(isProtectedCatalog(new Uint8Array(0))).toBe(false);
  });
});

describe("protect / unlock round trip", () => {
  test("returns the exact original bytes", async () => {
    const sealed = await protectCatalog(plain, "correct horse", { name: "Shop", iterations: FAST });
    expect(await unlockCatalog(sealed, "correct horse")).toEqual(plain);
  });

  test("ciphertext does not contain the plaintext", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "Shop", iterations: FAST });
    expect(Buffer.from(sealed).includes(Buffer.from("pretend this is a catalog"))).toBe(false);
  });

  test("two protections of the same file differ (fresh salt and nonce)", async () => {
    const a = await protectCatalog(plain, "pw", { name: "Shop", iterations: FAST });
    const b = await protectCatalog(plain, "pw", { name: "Shop", iterations: FAST });
    expect(a).not.toEqual(b);
  });

  test("an empty and a large payload both survive", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
    for (const data of [new Uint8Array(0), big]) {
      const sealed = await protectCatalog(data, "pw", { name: "n", iterations: FAST });
      expect(await unlockCatalog(sealed, "pw")).toEqual(data);
    }
  });

  test("Unicode passwords are normalised, so NFC and NFD spellings match", async () => {
    const sealed = await protectCatalog(plain, "café-Ключ-🔑", { name: "n", iterations: FAST });
    expect(await unlockCatalog(sealed, "café-Ключ-🔑")).toEqual(plain);
  });

  test("the default iteration count is written into the header", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n" });
    const iterations = new DataView(sealed.buffer, sealed.byteOffset).getUint32(10);
    expect(iterations).toBe(600_000);
  });
});

describe("wrong password and tampering", () => {
  test("a wrong password is reported as wrong-password", async () => {
    const sealed = await protectCatalog(plain, "right", { name: "n", iterations: FAST });
    expect(await errorCode(unlockCatalog(sealed, "wrong"))).toBe("wrong-password");
    expect(await errorCode(unlockCatalog(sealed, ""))).toBe("wrong-password");
  });

  test("flipping any byte of the body, public name or header is detected", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "Shop", cover, iterations: FAST });
    // magic and version/kdf/length fields fail structurally; the rest fail authentication.
    const positions = [14, 30, 50, 50 + 16, sealed.length - 1, sealed.length - 20];
    for (const pos of positions) {
      const bad = sealed.slice();
      bad[pos] = (bad[pos] ?? 0) ^ 0x01;
      const code = await errorCode(unlockCatalog(bad, "pw"));
      expect(["wrong-password", "corrupt"]).toContain(code);
    }
  });

  test("swapping the public name for another one is detected", async () => {
    const a = await protectCatalog(plain, "pw", { name: "AAAA", iterations: FAST });
    const bad = a.slice();
    bad.set(new TextEncoder().encode("BBBB"), 50 + '{"name":"'.length);
    expect(readProtectedInfo(bad).name).toBe("BBBB");
    expect(await errorCode(unlockCatalog(bad, "pw"))).toBe("wrong-password");
  });

  test("files cut inside the header are corrupt, not a crash", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n", iterations: FAST });
    for (const len of [8, 20, 49, 60]) {
      expect(await errorCode(unlockCatalog(sealed.slice(0, len), "pw"))).toBe("corrupt");
    }
  });

  test("a shortened ciphertext fails authentication (GCM cannot tell it from a wrong password)", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n", iterations: FAST });
    expect(await errorCode(unlockCatalog(sealed.slice(0, sealed.length - 10), "pw"))).toBe("wrong-password");
  });

  test("an out-of-range iteration count in the header is refused before any key work", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n", iterations: FAST });
    for (const iterations of [0, 999, 10_000_001, 0xffffffff]) {
      const bad = sealed.slice();
      new DataView(bad.buffer).setUint32(10, iterations);
      expect(await errorCode(unlockCatalog(bad, "pw"))).toBe("corrupt");
    }
  });

  test("an unknown format version or KDF is reported as unsupported-version", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n", iterations: FAST });
    const newer = sealed.slice();
    newer[8] = 2;
    expect(await errorCode(unlockCatalog(newer, "pw"))).toBe("unsupported-version");
    const otherKdf = sealed.slice();
    otherKdf[9] = 9;
    expect(await errorCode(unlockCatalog(otherKdf, "pw"))).toBe("unsupported-version");
  });

  test("a plain catalog is refused with not-protected", async () => {
    expect(await errorCode(unlockCatalog(plain, "pw"))).toBe("not-protected");
    expect(() => readProtectedInfo(plain)).toThrow(ProtectedCatalogError);
  });
});

describe("public metadata", () => {
  test("name and cover are readable without the password", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "Fuller Transmission — Каталог", cover, iterations: FAST });
    const info = readProtectedInfo(sealed);
    expect(info.version).toBe(1);
    expect(info.name).toBe("Fuller Transmission — Каталог");
    expect(info.cover?.mime).toBe("image/jpeg");
    expect(info.cover?.bytes).toEqual(cover.bytes);
  });

  test("cover is optional", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "Shop", iterations: FAST });
    expect(readProtectedInfo(sealed).cover).toBeNull();
    expect(await unlockCatalog(sealed, "pw")).toEqual(plain);
  });

  test("an oversized cover is rejected when protecting", async () => {
    const big = { mime: "image/png", bytes: new Uint8Array(PROTECT_MAX_COVER_BYTES + 1) };
    expect(await errorCode(protectCatalog(plain, "pw", { name: "n", cover: big, iterations: FAST }))).toBe("invalid-input");
  });
});

describe("input validation", () => {
  test("an empty password is refused", async () => {
    expect(await errorCode(protectCatalog(plain, "", { name: "n", iterations: FAST }))).toBe("invalid-input");
  });

  test("double protection is refused", async () => {
    const sealed = await protectCatalog(plain, "pw", { name: "n", iterations: FAST });
    expect(await errorCode(protectCatalog(sealed, "pw", { name: "n", iterations: FAST }))).toBe("invalid-input");
  });

  test("silly iteration counts are refused", async () => {
    for (const iterations of [0, 10, 1.5, 20_000_000]) {
      expect(await errorCode(protectCatalog(plain, "pw", { name: "n", iterations }))).toBe("invalid-input");
    }
  });
});

describe("integration with openCatalog", () => {
  const wasm = createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm");

  test("a real catalog survives protect, unlock, open; openCatalog on the locked file says locked", async () => {
    const SQL = await initSqlite(() => wasm);
    const db = createEmptyCatalog(SQL, "Secret shop");
    const bytes = exportCatalog(db);

    const sealed = await protectCatalog(bytes, "pw", { name: "Secret shop", iterations: FAST });
    expect(() => openCatalog(SQL, sealed)).toThrow(ProtectedCatalogError);
    try {
      openCatalog(SQL, sealed);
    } catch (e) {
      expect((e as ProtectedCatalogError).code).toBe("locked");
    }

    const reopened = openCatalog(SQL, await unlockCatalog(sealed, "pw"));
    expect(readMeta(reopened).catalogName).toBe("Secret shop");
  });
});
