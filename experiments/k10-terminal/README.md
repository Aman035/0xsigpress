# K10-terminal: finding the Keccak terminal prover (research, throwaway)

Date: 4 Nov 2026. Machine: Apple M4 (base), 16 GB. Clones live in `vendor/` (git-ignored).

## Verdict

**Found.** The terminal prover is public: branch `recursive-verifier` of
[Client-Side-Proving/leanVM](https://github.com/Client-Side-Proving/leanVM/tree/recursive-verifier)
(a fork of leanEthereum/leanVM), HEAD `fb0909d`, main commit `9c9ff81` "Add Spartan-WHIR recursion and
grouped terminal proofs" by Alex Kuzmin, 15 Oct 2026. Licence: **Apache-2.0** (`LICENSE` file checked).
Its README says the fork "adds a Spartan-WHIR verifier guest, explicit recursive proof profiles, grouped
LogUp proving, and Keccak terminal proof export". The entry point is `script/run_terminal_fixture.py`,
which builds `leanvm-recursion-profile` and writes `benchmark-results/<dir>/native/root-fixture.json`:
the exact path the Solidity generator in sol-spartan-whir expects (`../leanVM/benchmark-results/terminal-c1-...`).

**But it does not produce proofs our deployed verifier accepts.** Three reasons, all from source:

1. **Protocol version.** The deployed verifier (`0x4fa20bd7…c4be`, from `alxkzmn/sol-spartan-whir@18eda72`)
   derives its Fiat-Shamir capacity with profile tag `0x57500001`
   (`script/generate_leanvm_two_commitment_terminal_fixture.py:175`). The prover now uses `0x57500002`
   (`crates/lean_prover/src/profile.rs:421`, with a unit test asserting the two differ). The README:
   "WHIR continuation rounds keep the carried sumcheck claim at coefficient one and assign the new OOD
   and query claims coefficients gamma, gamma^2, … earlier client and LeanVM proof artifacts require
   regeneration after the corresponding protocol corrections." So the C1 verifier we deployed is from a
   superseded (corrected) protocol version. Upstream `ethereum/sol-whir-p3@b82359e` uses `0x57500002`
   and in PR #11 "Remove[d] superseded C1 outputs", keeping only the grouped terminal.
2. **Pinned programs.** Every generated verifier pins the fixed-program commitment (the three
   concatenated bytecodes: child guest, lift, root) and the WHIR profile. A different child program
   (ours) means a newly generated verifier contract. That is by design, not a blocker: the generator
   emits the contract from `root-fixture.json`.
3. **The source revision behind the deployed fixture is not published.** The branch is one squashed
   commit on top of upstream `98cb2ad`; the September state that produced `0x57500001` fixtures is not
   in it.

So "reproduce the fixture the deployed contract accepts" is not reachable. "Generate a fresh terminal
proof and a matching verifier" is reachable in principle (see below).

## How the terminal chain works (read from source)

Programs, in order (`crates/spartan_whir_guest/README.md`, `crates/rec_aggregation/src/binary_recursion.rs`):

1. **Direct proof.** A leanVM guest program runs; its execution proof uses a Poseidon1 profile.
   In the authors' pipeline the guest is a Spartan-WHIR verifier checking a client proof (a Privacy
   Pools-style withdrawal R1CS from `ethereum/spartan-whir`). Public input: an 8-element statement digest.
2. **Lift.** `lift_execution_proof_with_profiles(child_bytecode, lifted_bytecode, application_digest, …)`
   verifies one direct proof inside leanVM, and hashes the child's bytecode claim with the
   application digest into its public input.
3. **Terminal root (binary node).** `prove_terminal_binary_node_c1_v1_with_preprocessing(spark, lift,
   root, [two lifted proofs], …)` verifies **two** lifts and computes
   `application_root = Poseidon1("NOD1", 2, left_digest, right_digest)` (`binary_application_root`).
   This root proof is made with the **Keccak240** hash profile (`terminal_keccak: true`) and is what the
   Solidity verifier checks. The Solidity side gets the application root through public memory.

Profiles: `crates/spartan_whir_guest/profiles/terminal_c1.json` (two-commitment C1, matches the
contract family we deployed) and `terminal_grouped.json` (grouped LogUp, the upstream choice;
"full composition security remains under review"). Both target 100-bit WHIR components with direct/lift/root
grinding 22/24/28 bits.

## What the terminal proof commits to, and binding it to our batch

- The terminal statement is the application root: an ordered Poseidon1 hash (KoalaBear, 8 field
  elements) of the two children's 8-element public inputs.
- The lift and terminal APIs take the child bytecode as a parameter (`child_bytecode: &Bytecode`, named
  `spark_bytecode` in the terminal), so the child does not have to be the Spartan guest. This branch also
  carries leanVM's KoalaBear XMSS aggregation (`rec_aggregation::aggregate_single_message_signatures`,
  `merge_single_message_aggregates`, `get_aggregation_bytecode()`), whose public input is
  `poseidon_hash_slice(input_data)` over (domain sep, pubkeys hash, hashed message, slot Merkle chunks,
  tweaks hash). That gives a plausible chain, **not tried end to end**:
  XMSS aggregate (KoalaBear/Poseidon) -> lift -> Keccak terminal root -> generated Solidity verifier.
- Gaps we found by reading code (none tested):
  - The XMSS aggregation proves with `default_whir_config(log_inv_rate)`; `lift` verifies children with
    an explicit `WhirExecutionProfile`. The two must be made to agree (new profile plumbing or an
    explicit profile for the aggregation program).
  - The terminal root needs exactly two children. With one batch, either split it into two aggregates
    or write a one-child root.
  - Single-message aggregation assumes one shared message per aggregate; distinct per-user messages go
    through `merge_single_message_aggregates` (up to `MAX_RECURSIONS = 16` children per merge), which
    costs recursion steps (cost unmeasured).
  - The 32-byte batch root on chain: the contract sees a Poseidon1/KoalaBear application root. To bind
    it to a Keccak batch root of (pubkey, message) pairs we would either (a) compute Poseidon1 over the
    batch in Solidity (gas unmeasured; sol-spartan-whir already has `LeanVmPoseidon1.sol`), or (b) have
    a guest program compute a Keccak digest of the batch and expose it as the public input (we did not
    check whether this KoalaBear branch has an in-VM Keccak precompile; without one Keccak is ordinary
    instructions, cost unmeasured).
  - The leanXMSS here is the KoalaBear/Poseidon variant (not the Keccak leanXMSS of leanVM `main`
    used in K5). The user-side / fraud-proof Solidity check must match whichever scheme we pick.
  - Prover memory: the authors report 17.8 GB peak RSS for their production chain (M4 Pro, 48 GB).
    Our box has 16 GB. Our chain's numbers are unmeasured.

## What we ran

```sh
git clone --branch recursive-verifier https://github.com/Client-Side-Proving/leanVM.git vendor/leanVM   # fb0909d
cd vendor/leanVM   # rust-toolchain.toml pins nightly-2026-03-04 (rustup installs it)
cargo build --locked --release -p spartan_whir_guest --bin leanvm-recursion-profile --bin leanvm-binary-node  # 1m05s
/usr/bin/time -l ./target/release/leanvm-binary-node smoke-control > ../../results/smoke-control.json
cargo test --locked --release -p lean_prover --test terminal_hash_profiles
F=crates/spartan_whir_guest/testdata/full_zk_spark_poseidon1
./target/release/leanvm-recursion-profile $F $F out.json crates/spartan_whir_guest/profiles/terminal_c1.json
cast call --rpc-url https://testnet-rpc.monad.xyz 0x4fa20bd740deb7969416749dbedb5d8e5b65c4be \
  0x$(xxd -p ../../../k3/vendor/sol-spartan-whir/testdata/leanvm_terminal/KeccakPublicMemoryC1Pow28T6/calldata.bin | tr -d '\n')
```

| Step | Result (measured here) |
|---|---|
| Build | OK, 1 min 05 s |
| `smoke-control`: control Spartan-WHIR guest -> lift -> binary node (Poseidon, **not** the Keccak terminal) | passed native verification; mutated application digest and root rejected. Child prove 0.62 s, lift 0.74 s, node 1.51 s; lift proof 266,961 B, node proof 275,562 B; 5.74 s wall, 1.46 GB max RSS. `results/smoke-control.json` |
| `terminal_hash_profiles` test: prove + verify a toy program under the **Keccak240** terminal hash profile, reject wrong hash/profile/bytecode/input | 1 passed (`results/terminal-hash-profiles.txt`) |
| Full terminal runner with the one checked-in client fixture used twice | refused: "use two distinct application statements for the binary experiment". A second client fixture needs `ethereum/spartan-whir` (no LICENSE; Circom withdrawal circuit) — not attempted in the time box |
| Deployed verifier, `eth_call` with the K3 fixture | still returns `true` |

We did **not** produce a terminal proof, and did not check any new proof against the deployed
contract: per the version analysis above, it would be rejected.

## Search log (where we looked)

- `alxkzmn` repos (`gh api users/alxkzmn/repos`): forks `alxkzmn/leanVM` (branches `main`,
  `blake3-precompile`, `whir-based`) and `alxkzmn/leanVM-b` (40+ binary-field branches); no terminal code
  on branch names checked.
- `leanEthereum/leanVM` (= the renamed leanMultisig): 180+ branches, `koalabear` branch cloned
  (`1594657`, has `python-verifier`, no Keccak/terminal code); tags v0.8-v0.10.
- `gh search code` for fixture identifiers (`leanvm-terminal-two-commitment-fixture-v1`,
  `leanvm-keccak240-v1`, `verifyC1V1`): only `ethereum/sol-whir-p3` (code search only indexes default
  branches, which is why the prover branch did not show up).
- `gh search commits --author alxkzmn`: led to `ethereum/spartan-whir` PR #5 "Prepare Spartan-WHIR
  proofs for recursive verification in LeanVM-a" and to the `Client-Side-Proving` org, whose
  `leanVM` fork has the `recursive-verifier` branch.
- Inside `experiments/k3/vendor/sol-spartan-whir`: `AGENTS.md`, README and the generator reference
  `../leanVM/benchmark-results/terminal-c1-b-threshold6-pow28/native/root-fixture.json` and
  `../leanVM/crates/lean_prover/python-verifier`; the manifest has `native_proof_sha256` but no source
  commit hash.

## Licences (checked 4 Nov 2026)

| Repo | Licence |
|---|---|
| Client-Side-Proving/leanVM (`recursive-verifier`) | Apache-2.0 (`LICENSE` file) — reusable |
| leanEthereum/leanVM | MIT + Apache-2.0 — reusable |
| ethereum/sol-whir-p3, alxkzmn/sol-spartan-whir | **no LICENSE file** (SPDX headers + README say MIT) — research only |
| ethereum/spartan-whir, Client-Side-Proving/spartan-whir-export | **no LICENSE file** — research only |

So the prover side is clean to reuse; the Solidity verifier still is not, until a LICENSE file appears.
`outreach.md` is a draft (not sent) asking for licence files and about non-Spartan children.

## Next step

Build the shortest real chain on this branch: a small leanVM XMSS aggregate (e.g. 2 aggregates of a
few signatures) as the child program -> `lift` -> `prove_terminal_binary_node_c1_v1_with_preprocessing`
with `terminal_keccak`, export `root-fixture.json` in the same schema the recursion-profile binary
writes, generate a C1 verifier with `ethereum/sol-whir-p3`'s generator (tag `0x57500002`), and verify on
anvil, then Monad testnet. Effort (estimate, not measured): 1-2 weeks if the profile mismatch is just
plumbing; more if the 16 GB machine cannot hold the chain (rent a 64 GB box).
