# Sigpress (working name)

Post-quantum signature aggregation for Monad. Users sign with hash-based post-quantum keys; an aggregator proves many signatures valid in one hash-based STARK; one contract on Monad verifies the proof, so quantum-safe transactions don't eat Monad's block space. Target: a Monad Blitz hackathon entry, then a real product (about 4 months).

## Read first

All docs live in `docs/`.

- `docs/idea.md`: what it is, what's new, honest limits.
- `docs/pitch.md`: the pitch. Bracketed numbers are placeholders until measured.
- `docs/plan.md`: kill tests K1-K10 first, then the build. **The source of truth for what to do next.** K1/K2 pass; next action is K3 → K4.
- `docs/research.md`: sourced facts about Monad, PQ verifiers, EIPs and aggregation (as of 4 Nov 2026).
- `docs/decisions.md`: the fact-check pass and every kill-test answer, with sources.
- `docs/demo.md`: what the Blitz demo looks like, and the build checklist for the day.

## Rules

- **Kill tests before building.** Work through `docs/plan.md` Part 1 in order (K1, K2 now pass; next is K3-K6; K4 is the go/no-go). Do not start the product build until the go/no-go table is answered.
- **Record every answer** in `docs/decisions.md`: the test, what was measured, the source or command, and the decision. Update `docs/pitch.md` brackets only with measured numbers.
- **Never state an unmeasured number as fact.** Mark claims from secondary sources as unverified. The TPS/capacity figures, leanMultisig benchmarks and calldata pricing in `docs/research.md` were fact-checked on 4 Nov 2026 (see `docs/decisions.md`); the block-capacity arithmetic is now re-derived from MIP-12, but proof size, on-Monad verifier gas and proving speed remain unmeasured.
- **Monad Blitz rule:** project code must be written during the event, in a public repo, deployed on Monad testnet. Kill-test code is research: keep it in `experiments/` (one folder per test) and treat it as throwaway; it will not be reused as the Blitz codebase.
- **Licences:** reuse only MIT or Apache-2.0 code. Kohaku `pq-account` and NiceTry have no licence file; do not copy them.
- **Commits** (once this is a git repo): Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), one line, no co-author or attribution trailers.
- **Explain plainly.** The user wants honest, plain-language reports: what was done, what was found, what it means for go/no-go.

## Useful facts

- Monad testnet: chain ID 10143, RPC https://testnet-rpc.monad.xyz, faucet https://faucet.monad.xyz. Mainnet chain ID 143.
- 30M gas per transaction, charged on the gas limit (not gas used); 128 KB contracts (MIP-2); 300 ms blocks / 600 ms finality; block cap 1,500,000 bytes (~1.5 MB) and 3,750 tx (MIP-12, Final, verified). Max tx ~384 KiB is still unverified. Calldata floor 40 gas/B (not EIP-7981, which is access-list cost).
- ERC-4337 EntryPoints v0.6-v0.8 on Monad (v0.9 unverified on the explorer); `IAggregator` / `handleAggregatedOps` still defined in v0.9. Rundler supports the aggregator path.
- Tooling available on this machine: Foundry (forge, cast, anvil), Node 23, pnpm, Docker, Playwright.
