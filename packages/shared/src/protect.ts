/**
 * Password protection for a finished `.ecatm` (a "protected catalog").
 *
 * The plain SQLite bytes are wrapped in one AES-256-GCM envelope; the viewer
 * asks for the password, decrypts in memory, then hands the SQLite bytes to
 * `openCatalog` as usual. This is access protection for paid catalogs, not
 * copy protection: whoever holds the password can read (and extract) the data.
 *
 * File layout (all integers big-endian):
 *
 *   offset  size  field
 *        0     8  magic "ECMPROT\0"   (never collides with "SQLite format 3\0")
 *        8     1  format version      (currently 1)
 *        9     1  KDF id              (1 = PBKDF2-HMAC-SHA256)
 *       10     4  KDF iterations
 *       14    16  KDF salt
 *       30    12  AES-GCM nonce
 *       42     4  public metadata length (M)
 *       46     4  public cover length (C)
 *       50     M  public metadata, UTF-8 JSON: { name, coverMime? }
 *     50+M     C  public cover image bytes
 *   50+M+C   rest  AES-GCM ciphertext + 16-byte tag of the SQLite file
 *
 * Everything before the ciphertext is the GCM additional data, so swapping the
 * public name/cover, or any header field, makes decryption fail. The name and
 * cover are deliberately readable without the password (storefront preview).
 * Version, KDF id and the iteration count are part of the format, so a later
 * version can raise the cost or change the KDF without breaking old files.
 */

const MAGIC = new Uint8Array([0x45, 0x43, 0x4d, 0x50, 0x52, 0x4f, 0x54, 0x00]); // "ECMPROT\0"
const FORMAT_VERSION = 1;
const KDF_PBKDF2_SHA256 = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FIXED_HEADER_BYTES = 50;

/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. */
export const PROTECT_DEFAULT_ITERATIONS = 600_000;
/** Bounds accepted from a file, so a crafted header can't freeze the tab or weaken the KDF to nothing. */
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;
/** Cap for the plaintext cover shown before unlocking; it is a thumbnail, not the catalog's own images. */
export const PROTECT_MAX_COVER_BYTES = 400 * 1024;
const MAX_META_BYTES = 16 * 1024;

export type ProtectedCatalogErrorCode =
  | "not-protected"
  | "unsupported-version"
  | "corrupt"
  | "wrong-password"
  | "locked"
  | "invalid-input";

export class ProtectedCatalogError extends Error {
  constructor(
    readonly code: ProtectedCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtectedCatalogError";
  }
}

export interface ProtectedCatalogCover {
  mime: string;
  bytes: Uint8Array;
}

/** What anyone can read from a protected file without the password. */
export interface ProtectedCatalogInfo {
  version: number;
  name: string;
  cover: ProtectedCatalogCover | null;
}

export interface ProtectOptions {
  /** Public name shown on the lock screen. */
  name: string;
  /** Optional public cover (small JPEG/PNG/WebP, at most PROTECT_MAX_COVER_BYTES). */
  cover?: ProtectedCatalogCover | null;
  /** PBKDF2 iterations; defaults to PROTECT_DEFAULT_ITERATIONS. Lower only in tests. */
  iterations?: number;
}

/** True when the bytes start with the protected-catalog magic. Cheap: looks at 8 bytes. */
export function isProtectedCatalog(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

interface ParsedEnvelope {
  version: number;
  iterations: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  info: ProtectedCatalogInfo;
  /** Header + public metadata + cover: the GCM additional data. */
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (!isProtectedCatalog(bytes)) {
    throw new ProtectedCatalogError("not-protected", "This file is not a password-protected catalog.");
  }
  if (bytes.length < FIXED_HEADER_BYTES + TAG_BYTES) {
    throw new ProtectedCatalogError("corrupt", "The protected catalog file is truncated.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(8);
  if (version !== FORMAT_VERSION) {
    throw new ProtectedCatalogError(
      "unsupported-version",
      `This protected catalog uses format version ${version}; this app understands version ${FORMAT_VERSION}. Update the app.`,
    );
  }
  const kdf = view.getUint8(9);
  if (kdf !== KDF_PBKDF2_SHA256) {
    throw new ProtectedCatalogError("unsupported-version", `Unknown key-derivation method ${kdf}.`);
  }
  const iterations = view.getUint32(10);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new ProtectedCatalogError("corrupt", "The protected catalog header is invalid.");
  }
  const metaLen = view.getUint32(42);
  const coverLen = view.getUint32(46);
  const bodyStart = FIXED_HEADER_BYTES + metaLen + coverLen;
  if (
    metaLen > MAX_META_BYTES ||
    coverLen > PROTECT_MAX_COVER_BYTES ||
    bodyStart + TAG_BYTES > bytes.length
  ) {
    throw new ProtectedCatalogError("corrupt", "The protected catalog file is truncated or damaged.");
  }

  let name: string;
  let coverMime: string | undefined;
  try {
    const meta = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + metaLen)),
    ) as { name?: unknown; coverMime?: unknown };
    if (typeof meta.name !== "string") throw new Error("name");
    name = meta.name;
    if (typeof meta.coverMime === "string") coverMime = meta.coverMime;
  } catch {
    throw new ProtectedCatalogError("corrupt", "The protected catalog header is damaged.");
  }

  const coverBytes = bytes.subarray(FIXED_HEADER_BYTES + metaLen, bodyStart);
  return {
    version,
    iterations,
    salt: bytes.subarray(14, 14 + SALT_BYTES),
    nonce: bytes.subarray(30, 30 + NONCE_BYTES),
    info: {
      version,
      name,
      cover: coverLen > 0 && coverMime ? { mime: coverMime, bytes: coverBytes.slice() } : null,
    },
    aad: bytes.subarray(0, bodyStart),
    ciphertext: bytes.subarray(bodyStart),
  };
}

/** Reads the public name and cover of a protected file. No password needed, nothing is decrypted. */
export function readProtectedInfo(bytes: Uint8Array): ProtectedCatalogInfo {
  return parseEnvelope(bytes).info;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ProtectedCatalogError(
      "invalid-input",
      "Encryption is not available here: the page must be served over HTTPS (or localhost).",
    );
  }
  // NFKC so the same password typed on different devices/keyboards derives the same key.
  const material = await subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wraps plain `.ecatm` bytes in a password-protected envelope. */
export async function protectCatalog(
  plain: Uint8Array,
  password: string,
  options: ProtectOptions,
): Promise<Uint8Array> {
  if (!password) throw new ProtectedCatalogError("invalid-input", "A password is required.");
  if (isProtectedCatalog(plain)) {
    throw new ProtectedCatalogError("invalid-input", "This catalog is already password-protected.");
  }
  const iterations = options.iterations ?? PROTECT_DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new ProtectedCatalogError("invalid-input", "Invalid iteration count.");
  }
  const cover = options.cover ?? null;
  if (cover && cover.bytes.length > PROTECT_MAX_COVER_BYTES) {
    throw new ProtectedCatalogError(
      "invalid-input",
      `The public cover is too large (${cover.bytes.length} bytes; the limit is ${PROTECT_MAX_COVER_BYTES}).`,
    );
  }

  const metaBytes = new TextEncoder().encode(
    JSON.stringify(cover ? { name: options.name, coverMime: cover.mime } : { name: options.name }),
  );
  if (metaBytes.length > MAX_META_BYTES) {
    throw new ProtectedCatalogError("invalid-input", "The public catalog name is too long.");
  }
  const coverBytes = cover ? cover.bytes : new Uint8Array(0);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const bodyStart = FIXED_HEADER_BYTES + metaBytes.length + coverBytes.length;
  const out = new Uint8Array(bodyStart + plain.length + TAG_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(8, FORMAT_VERSION);
  view.setUint8(9, KDF_PBKDF2_SHA256);
  view.setUint32(10, iterations);
  out.set(salt, 14);
  out.set(nonce, 30);
  view.setUint32(42, metaBytes.length);
  view.setUint32(46, coverBytes.length);
  out.set(metaBytes, FIXED_HEADER_BYTES);
  out.set(coverBytes, FIXED_HEADER_BYTES + metaBytes.length);

  const key = await deriveKey(password, salt, iterations);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: out.subarray(0, bodyStart) as BufferSource },
    key,
    plain as BufferSource,
  );
  out.set(new Uint8Array(sealed), bodyStart);
  return out;
}

/**
 * Decrypts a protected file into the plain SQLite bytes.
 * Throws `ProtectedCatalogError`: `wrong-password` (GCM can't tell a wrong
 * password from a tampered file, so this covers both), `corrupt`,
 * `unsupported-version` or `not-protected`.
 */
export async function unlockCatalog(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const env = parseEnvelope(bytes);
  const key = await deriveKey(password, env.salt, env.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: env.nonce as BufferSource, additionalData: env.aad as BufferSource },
      key,
      env.ciphertext as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new ProtectedCatalogError("wrong-password", "Wrong password, or the file was modified.");
  }
}
