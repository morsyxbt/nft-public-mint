import chalk from "chalk";

// Single source of truth for all CLI output. Event logs use the strict
// `[LEVEL] message` format (INFO / WARN / ERROR / DEBUG). Section headers,
// key/value summaries and dim data lines are rendered separately so the leveled
// stream stays scannable and free of box-drawing and emoji.

export type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const TAG_COLOR: Record<Level, (s: string) => string> = {
  INFO: chalk.white,
  WARN: chalk.yellow,
  ERROR: chalk.red,
  DEBUG: chalk.gray,
};

let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

function emit(level: Level, msg: string): void {
  if (level === "DEBUG" && !debugEnabled) return;
  process.stdout.write(`${TAG_COLOR[level](`[${level}]`)} ${msg}\n`);
}

export const info = (msg: string): void => emit("INFO", msg);
export const warn = (msg: string): void => emit("WARN", msg);
export const error = (msg: string): void => emit("ERROR", msg);
export const debug = (msg: string): void => emit("DEBUG", msg);

// Success marker — INFO level with a green [OK] token (no emoji).
export function ok(msg: string): void {
  emit("INFO", `${chalk.green("[OK]")} ${msg}`);
}

// Slim section header. No ASCII boxes.
export function section(title: string): void {
  process.stdout.write(`\n${chalk.bold.white(title)}\n`);
}

// Indented, dim data line for sub-detail (tx hashes, explorer links, notes).
export function detail(msg: string): void {
  process.stdout.write(`  ${chalk.gray(msg)}\n`);
}

// Key/value pair for compact summaries (label padded, value bright).
export function kv(label: string, value: string): void {
  process.stdout.write(`  ${chalk.gray(label.padEnd(14))} ${chalk.white(value)}\n`);
}

// Compact banner: bold title with an optional dim subtitle. No box drawing.
export function banner(title: string, subtitle?: string): void {
  process.stdout.write(`${chalk.bold.cyan(title)}\n`);
  if (subtitle) process.stdout.write(`${chalk.gray(subtitle)}\n\n`);
}
