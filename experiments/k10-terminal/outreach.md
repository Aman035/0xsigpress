# Outreach draft (NOT sent, NOT posted)

Target: Alex Kuzmin (alxkzmn), as a GitHub issue on `Client-Side-Proving/leanVM` (or `ethereum/sol-whir-p3`),
or by email. Review and edit before sending.

---

**Title:** Licence files, and using the Keccak terminal with a non-Spartan child program

Hi Alex,

Thank you for the LeanVM terminal work. We are a small team building a research prototype that aggregates
hash-based (leanXMSS) signatures with leanVM and verifies the result in one EVM transaction. We ran the
`LeanVmTwoCommitmentTerminal_KeccakPublicMemoryC1Pow28T6` verifier from `alxkzmn/sol-spartan-whir@18eda72`
on a public testnet (fixture proof accepted, ~12.8M gas estimate, 106,628 B calldata) and found the
terminal prover on the `recursive-verifier` branch of `Client-Side-Proving/leanVM` (`fb0909d`).

A few questions, if you have time:

1. **Licences.** `Client-Side-Proving/leanVM` has an Apache-2.0 LICENSE. `ethereum/sol-whir-p3`,
   `alxkzmn/sol-spartan-whir`, `ethereum/spartan-whir` and `Client-Side-Proving/spartan-whir-export`
   have no LICENSE file, although the Solidity sources carry `SPDX-License-Identifier: MIT` and the
   README says MIT. Would you be willing to add LICENSE files so downstream use is unambiguous?
2. **Version match.** The C1 fixture in `sol-spartan-whir@18eda72` uses profile domain tag `0x57500001`,
   while the branch uses `0x57500002` (continuation-claim batching fix) and upstream `sol-whir-p3`
   removed the C1 outputs in PR #11. Is the grouped terminal (`GroupedLogupKeccakPow28T6`) the one you
   now recommend, and is its "security under review" note still current? Is there a C1 or grouped
   verifier that matches the branch HEAD?
3. **Other child programs.** `lift_execution_proof_with_profiles` and
   `prove_terminal_binary_node_c1_v1_with_preprocessing` look generic over the child bytecode. Do you
   expect the chain to work with the leanVM XMSS aggregation program (`rec_aggregation`,
   `get_aggregation_bytecode()`) as the child instead of the Spartan-WHIR guest? It uses
   `default_whir_config` rather than an explicit `WhirExecutionProfile`. Is there a known obstacle?
4. **Single child.** The terminal root verifies two lifted proofs. Is a one-child terminal (lift then
   Keccak root) planned, or should we always pair two aggregates?
5. **Statement on chain.** The terminal binds the Poseidon1 application root as public memory. Is there
   a recommended way to expose a Keccak digest of the application statement to the EVM side, so a
   contract can check it without implementing Poseidon1?
6. **Resources.** The README reports ~17.8 GB peak RSS for the production chain. Any settings you'd
   suggest for a 16 GB machine?

We are happy to share our measurements and any fixes back upstream.

Thanks,
Sumith (sigpress)
