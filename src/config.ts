import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_PATH = path.join(os.homedir(), ".reviewer", "config.json");

/** What the agent should do when a review is still pending after the CLI timeout. */
export type WaitMode = "stop" | "poll";

export interface Config {
  waitMode: WaitMode;
  /** Review mode: when true, the Claude Code PreToolUse hook intercepts Edit/Write calls. */
  hookEnabled: boolean;
}

export const DEFAULTS: Config = { waitMode: "stop", hookEnabled: false };

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
