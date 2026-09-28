import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same one-small-JSON-file approach as catalog-server's config.ts — only the output folder needs to survive a restart. */
export interface Config {
  outputRoot: string;
}

/**
 * The person's real home folder. Inside a strictly confined snap, HOME (and
 * so homedir()) is the snap's own private ~/snap/<name>/<revision> — fine
 * for the config file below, but imports saved there would be buried where
 * nobody looks for them. snapd sets SNAP_REAL_HOME for exactly this.
 */
function realHome(): string {
  return process.env.SNAP_REAL_HOME || homedir();
}

function defaultOutputRoot(): string {
  const documents = join(realHome(), "Documents");
  return join(existsSync(documents) ? documents : realHome(), "ECM Store Importer");
}

const CONFIG_DIR = join(homedir(), ".ecm-store-importer");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
    return { outputRoot: typeof raw.outputRoot === "string" && raw.outputRoot ? raw.outputRoot : defaultOutputRoot() };
  } catch {
    return { outputRoot: defaultOutputRoot() };
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
