import chalk from "chalk";

// Single logging function: log(level, message).
//   log("INFO", "Firing immediately.")
//   log("WARN", "Gas too low")
// Levels: INFO | WARN | ERROR | DEBUG

export type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const LEVEL_COLOR: Record<Level, (s: string) => string> = {
  INFO: chalk.white,
  WARN: chalk.yellow,
  ERROR: chalk.red,
  DEBUG: chalk.gray,
};

let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

export function log(level: Level, message: string): void {
  if (level === "DEBUG" && !debugEnabled) return;
  process.stdout.write(`${LEVEL_COLOR[level](`[${level}]`)} ${message}\n`);
}
