// Merge results into out/results.json and copy to ../web/public/results.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGG_DIR } from "./chain.ts";

export function writeResults(patch: Record<string, unknown>): void {
  const outDir = resolve(AGG_DIR, "out");
  mkdirSync(outDir, { recursive: true });
  const p = resolve(outDir, "results.json");
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
  const next = JSON.stringify({ ...cur, ...patch }, null, 2) + "\n";
  writeFileSync(p, next);
  const webDir = resolve(AGG_DIR, "../web/public");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(resolve(webDir, "results.json"), next);
  console.log(`results -> ${p} and ${resolve(webDir, "results.json")}`);
}
