// Crash-safe JSON file store for the aggregator service and the watchtower (no database).
// Every write goes to a temp file in the same directory, is fsynced, then renamed over the target, so a
// crash leaves either the old file or the new one, never a torn one. bigints are stored as {"$big": "123"}.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_: string, v: any) => (v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v);

export function toJson(v: unknown, pretty = true): string {
  return JSON.stringify(v, replacer, pretty ? 2 : undefined);
}

export function fromJson<T>(s: string): T {
  return JSON.parse(s, reviver) as T;
}

/** Write `text` to `path` atomically (temp file + fsync + rename + directory fsync). */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // directory fsync is not supported everywhere; the rename is still atomic
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, toJson(value) + "\n");
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return fromJson<T>(readFileSync(path, "utf8"));
}
