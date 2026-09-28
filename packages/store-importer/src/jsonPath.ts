/**
 * The tiny path language presets use to point at a field inside one item of
 * a store's JSON: dot-separated keys, `[n]` for an array index and `[*]` for
 * "every element". "" means the value itself.
 *
 *   "title"               -> item.title
 *   "variants[0].sku"     -> item.variants[0].sku
 *   "variants[*].price"   -> every variant's price (always an array)
 *
 * Deliberately not JSONPath/JMESPath: presets stay readable for an outside
 * contributor, and this is all a product feed needs.
 */

type Step = { key: string } | { index: number } | { all: true };

function parse(path: string): Step[] {
  const steps: Step[] = [];
  for (const part of path.split(".")) {
    if (part === "") continue;
    const m = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!m) throw new Error(`Bad path segment "${part}" in "${path}"`);
    if (m[1]) steps.push({ key: m[1] });
    for (const b of m[2]!.matchAll(/\[(\d+|\*)\]/g)) {
      steps.push(b[1] === "*" ? { all: true } : { index: Number(b[1]) });
    }
  }
  return steps;
}

/** Every value the path reaches; a path without `[*]` yields at most one. */
export function selectAll(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const step of parse(path)) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || typeof value !== "object") continue;
      if ("key" in step) next.push((value as Record<string, unknown>)[step.key]);
      else if (!Array.isArray(value)) continue;
      else if ("index" in step) next.push(value[step.index]);
      else next.push(...value);
    }
    current = next.filter((v) => v !== undefined && v !== null);
  }
  return current;
}

export function select(root: unknown, path: string): unknown {
  return selectAll(root, path)[0];
}

/** The value as display text: strings/numbers/booleans only, anything else is "". */
export function selectText(root: unknown, path: string): string {
  const v = select(root, path);
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).trim() : "";
}
