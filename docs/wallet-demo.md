# Interactive wallet demo (testnet)

A browser wallet that sends real post-quantum transfers through the aggregator service to Monad testnet,
and shows every phase with the actual data (the one-time key, the signed message, the 2,144-byte
signature, the batch root, and every transaction).

**How it fits together:** the browser is pure UI. A small local `wallet-server` (`scripts/wallet-server.ts`)
serves the page and does the WOTS signing with the real SDK (`signCompactOp`), then POSTs the signed op to
the running aggregator service. The aggregator batches it, posts the root to Monad, finalizes, and runs the
bundle. The wallet polls and renders each step live. No key ever reaches the browser.

```
browser (web/wallet.html)  ──HTTP──▶  wallet-server (signs with the SDK)  ──POST /ops──▶  aggregator service  ──▶  Monad testnet
        ◀── per-phase detail + tx links ──┘           ◀── /ops/:id, /batches/:id ──┘
```

## Run it

From `aggregator/`, with `KEY_VAR` pointing at a funded key (`PRIVATE_KEY_K13` already holds ~1.5 MON):

```sh
pnpm install                                   # first time only (node_modules)

# terminal 1 — the aggregator service (batches + submits to Monad)
KEY_VAR=PRIVATE_KEY_K13 pnpm service           # http://127.0.0.1:8547

# terminal 2 — the wallet (serves the UI, signs, relays)
KEY_VAR=PRIVATE_KEY_K13 pnpm wallet            # http://127.0.0.1:8550  ← open this

# optional terminal 3 — watchtower, for the on-chain slash of a dishonest batch
KEY_VAR=PRIVATE_KEY_K13 DA_URL=http://127.0.0.1:8547 pnpm watchtower
```

Then open **http://127.0.0.1:8550**, pick a post-quantum account, and send a transfer. Watch it move:
signed in the wallet → queued by the aggregator → folded into a batch on Monad (submitBatch tx) →
challenge window → finalized → executed (executeBundle tx), with the recipient balance updating. Every
hash links to the Monad testnet explorer. The **"Forge a bad op"** button posts a tampered signature and
shows the aggregator reject it off chain; for the on-chain slash, run `pnpm service:tamper` with the
watchtower up.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `KEY_VAR` | `PRIVATE_KEY` | relayer that creates and funds the demo accounts (and, for `pnpm service`, pays the bond and gas) |
| `SERVICE_URL` | `http://127.0.0.1:8547` | the aggregator service the wallet relays to |
| `PORT` / `HOST` | `8550` / `127.0.0.1` | where the wallet UI is served |
| `ACCOUNTS` | `3` | demo accounts to create and fund on first run |
| `FUND` | `0.002` | MON put into each demo account |
| `ACCOUNT_SEED` | `sigpress-wallet` | deterministic seed tag for the demo accounts |
| `RECIPIENT` | derived | address that receives the transfers |

## Funding

The relayer/service key (`PRIVATE_KEY_K13` → `0xB746CD…`) had **1.55 MON** at build time — enough for the
demo accounts, bonds, and many cycles. Top up from https://faucet.monad.xyz if it runs low. A separate
watchtower key only needs gas for `challenge` (~0.02 MON) if you run the slash demo on its own key.
