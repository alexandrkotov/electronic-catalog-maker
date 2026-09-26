/**
 * Parses the composer's item table: a CSV/TSV file, or a range copied out of
 * Excel / Google Sheets and pasted in (the clipboard carries it as TSV).
 *
 * Columns are positional, only the headers of columns 6+ matter:
 *   1 No. · 2 folder · 3 name · 4 SKU · 5 description · 6.. extra keys
 */

export interface TableItem {
  /** 1-based line in the source text, for the report. */
  line: number;
  no: number;
  folder: string;
  name: string;
  sku: string;
  description: string;
  /** Header -> value, empty values left out. */
  extra: Record<string, string>;
}

export interface ParsedTable {
  extraKeys: string[];
  items: TableItem[];
  /** Rows whose first column isn't a positive whole number. */
  badNumbers: Array<{ line: number; value: string }>;
}

/** Picks the delimiter that splits the header line into the most columns. */
export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of ["\t", ";", ","]) {
    const count = splitRecords(header, d)[0]?.length ?? 0;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180-style split: quoted fields may hold the delimiter, newlines and "" escapes. */
export function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function parseTable(text: string): ParsedTable {
  const clean = text.replace(/^﻿/, "");
  const records = splitRecords(clean, detectDelimiter(clean));
  const header = (records[0] ?? []).map((h) => h.trim());
  const extraKeys = header.slice(5);
  const items: TableItem[] = [];
  const badNumbers: ParsedTable["badNumbers"] = [];
  // Line numbers follow records, not raw lines — a quoted multi-line cell is still one row.
  records.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (cells.every((c) => c.trim() === "")) return;
    const cell = (i: number) => (cells[i] ?? "").trim();
    const raw = cell(0);
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      badNumbers.push({ line, value: raw });
      return;
    }
    const extra: Record<string, string> = {};
    extraKeys.forEach((key, k) => {
      const value = cell(5 + k);
      if (key && value) extra[key] = value;
    });
    items.push({
      line,
      no: Number(raw),
      folder: cell(1),
      name: cell(2),
      sku: cell(3),
      description: cell(4),
      extra,
    });
  });
  return { extraKeys: extraKeys.filter((k) => k !== ""), items, badNumbers };
}

/** The downloadable starter table, so nobody has to guess the column order. */
export function templateCsv(): string {
  return [
    "No.,Folder,Name,SKU,Description,Price,buy_url",
    '1,,Oak armchair,CH-001,"Solid oak, linen seat",$240,',
    "2,Lighting,Floor lamp,LT-014,Brass stem,$95,",
    "3,Lighting,Table lamp,LT-022,,$60,",
    "",
  ].join("\r\n");
}
