import type { ImportedItem } from "./normalize";

/**
 * Grid Composer's table contract (README "Building a tile catalog from
 * photos and a table"): No., Folder, Name, SKU, Description positionally,
 * then any extra columns, each becoming an `extra` key. `buy_url` is the
 * one Composer and the viewer give a meaning to (Buy button + printed QR).
 */
export const HEADER = ["No.", "Folder", "Name", "SKU", "Description", "Price", "buy_url"];

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CRLF + a BOM, so Excel opens the file as UTF-8 too; Composer strips the BOM itself. */
export function toCsv(items: ImportedItem[]): string {
  const rows = [HEADER, ...items.map((it, i) => [String(i + 1), it.folder, it.name, it.sku, it.description, it.price, it.buyUrl])];
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
