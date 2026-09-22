import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Unlike collab-server (deliberately no persistence at all — see its
 * README/snapcraft.yaml), this app needs to remember the chosen folder and
 * LAN/internet mode across restarts, or every relaunch would make a
 * non-technical host redo the folder picker. A single small JSON file is
 * enough — no external dependency, no schema migrations to worry about.
 */
export interface Config {
  folderPath: string | null;
  mode: "lan" | "internet";
}

const DEFAULT_CONFIG: Config = { folderPath: null, mode: "lan" };

const CONFIG_DIR = join(homedir(), ".ecm-catalog-server");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
    return {
      folderPath: typeof raw.folderPath === "string" ? raw.folderPath : DEFAULT_CONFIG.folderPath,
      mode: raw.mode === "internet" ? "internet" : "lan",
    };
  } catch {
    return { ...DEFAULT_CONFIG }; // no file yet (first run), or it's corrupt — either way, start fresh rather than crash
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
