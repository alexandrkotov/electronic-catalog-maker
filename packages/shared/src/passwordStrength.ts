/** Shortest password the editor accepts when protecting a catalog. */
export const PROTECT_MIN_PASSWORD_LENGTH = 8;

export type PasswordStrength = "empty" | "weak" | "fair" | "strong";

/**
 * A deliberately simple, explainable rating for the protect dialog — length
 * first, then variety. It only guides the seller (the password still has to
 * reach buyers by email or chat, so a memorable one is normal); it is not a
 * guessability estimate.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return "empty";
  const chars = [...password];
  if (chars.length < PROTECT_MIN_PASSWORD_LENGTH) return "weak";
  if (new Set(chars).size <= 2) return "weak"; // "aaaaaaaa", "abababab"
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter((re) => re.test(password)).length;
  if (chars.length >= 16 || (chars.length >= 12 && classes >= 2)) return "strong";
  return classes >= 2 ? "fair" : "weak";
}
