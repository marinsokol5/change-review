import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The one path outside the per-review --dir: a persistent user preference has to
// survive the temp dirs. Written only by an explicit `config` command.
export const CONFIG_PATH = path.join(os.homedir(), ".change-review", "config.json");

/** What the agent should do when a review is still pending after the CLI timeout. */
export type WaitMode = "stop" | "poll";

export interface Config {
  waitMode: WaitMode;
}

export const DEFAULTS: Config = { waitMode: "stop" };

export function readConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(cfg: Config): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
