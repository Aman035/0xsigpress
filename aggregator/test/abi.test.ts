// The hand-written ABIs must match the compiled contracts (run `forge build` in contracts/ first; skipped
// if the artifacts are missing). Every TS entry must exist in the artifact with the same signature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregatorAbi, pqAccountAbi } from "../src/abi.ts";
import { xmssAccountAbi } from "../src/sdk/abi.ts";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/out");
type Item = { type: string; name?: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string }[] };
const sig = (x: Item) => `${x.type} ${x.name}(${(x.inputs ?? []).map((i) => i.type + (i.indexed ? " indexed" : "")).join(",")})${x.type === "function" ? `->(${(x.outputs ?? []).map((o) => o.type).join(",")})` : ""}`;

for (const [file, name, abi] of [
  ["OptimisticAggregator.sol", "OptimisticAggregator", aggregatorAbi],
  ["PQAccount.sol", "PQAccount", pqAccountAbi],
  ["XMSSAccount.sol", "XMSSAccount", xmssAccountAbi],
] as const) {
  const path = resolve(OUT, file, `${name}.json`);
  test(`${name} TS ABI matches the artifact`, { skip: existsSync(path) ? false : "run forge build" }, () => {
    const art = new Set((JSON.parse(readFileSync(path, "utf8")).abi as Item[]).filter((x) => x.name).map(sig));
    for (const x of abi as readonly Item[]) if (x.name) assert.ok(art.has(sig(x)), `${sig(x)} not in ${name}`);
  });
}
