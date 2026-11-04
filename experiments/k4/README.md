# K4 — hash-based STARK proof verified on Monad testnet

Date: 4 Nov 2026. Chain 10143. Verifier and proof from K3 (`experiments/k3/`, sol-spartan-whir @ `18eda72`,
contract `LeanVmTwoCommitmentTerminal_KeccakPublicMemoryC1Pow28T6`, fixture
`testdata/leanvm_terminal/KeccakPublicMemoryC1Pow28T6/calldata.bin`). Research only: the verifier repo
has no LICENSE file (sources marked MIT), so nothing from it is copied into the product.

| Step | Result | Tx / evidence |
|---|---|---|
| Deploy verifier (62,758 B initcode, ~62.7 KB runtime; > Ethereum's 24 KB, < Monad's 128 KB) | success, 14,500,000 gas charged (limit) | `0xef7941d1ae5ced7b0f912dcb5a1a1b6a1fd6c2c711be9574df76da42d6f529a0` → `0x4fa20bd740deb7969416749dbedb5d8e5b65c4be` |
| `eth_call` with the proof | returns `true` | RPC |
| `eth_estimateGas` for the verify | **12,837,028 gas** | RPC |
| Verify tx (proof as calldata, **106,628 B**, one tx) | **success**, 13,500,000 gas charged (= limit we set; Monad charges the limit) | `0x3ab6054a444f6f52bc4054ccbfc2b621dfc91564ba324de62c4ab9cc8fec968c` |
| Tampered proof (1 bit flipped at byte 60,000) | **reverts `MERKLE_ROOT`** | `eth_call` |

Repro:
```sh
N=LeanVmTwoCommitmentTerminal_KeccakPublicMemoryC1Pow28T6; V=experiments/k3/vendor/sol-spartan-whir
cast send --rpc-url https://testnet-rpc.monad.xyz --private-key $PK --gas-limit 14500000 --create $(jq -r .bytecode.object $V/out/$N.sol/$N.json)
cast send --rpc-url https://testnet-rpc.monad.xyz --private-key $PK --gas-limit 13500000 <verifier> 0x$(xxd -p $V/testdata/leanvm_terminal/KeccakPublicMemoryC1Pow28T6/calldata.bin | tr -d '\n')
```

What it does not show: the proven statement is the authors' test instance, not our N signature checks.
