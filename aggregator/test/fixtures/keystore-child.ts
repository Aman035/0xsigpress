// Child process for the kill-during-sign test: signs in a loop and "releases" each signature by writing
// its leaf index to stdout. The parent SIGKILLs it at an arbitrary moment.
// argv: statePath seed height
import { keccak256, toHex, type Hex } from "viem";
import { KeyStore } from "../../src/sdk/keystore.ts";
import { xmssKeygen } from "../../src/sdk/xmss.ts";

const [statePath, seed, height] = process.argv.slice(2) as [string, Hex, string];
const key = xmssKeygen(seed, Number(height));
const ks = KeyStore.open(statePath, { onWarn: () => {} });
process.stdout.write("ready\n");
for (let n = 0; ; n++) {
  const sig = ks.sign(key, keccak256(toHex(`msg ${process.pid} ${n}`)));
  process.stdout.write(`${sig.leafIndex}\n`);
}
