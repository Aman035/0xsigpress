// Minimal ABIs matching the shared spec interfaces.
export const naiveLaneAbi = [
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pkHash", type: "bytes32" },
      { name: "m", type: "bytes32" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "error", name: "InvalidSignature", inputs: [] },
  {
    type: "event",
    name: "Verified",
    inputs: [
      { name: "pkHash", type: "bytes32", indexed: true },
      { name: "m", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const aggregatorAbi = [
  {
    type: "function",
    name: "submitBatch",
    stateMutability: "payable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "count", type: "uint32" },
      { name: "dataURI", type: "string" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "challenge",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "pkHash", type: "bytes32" },
      { name: "m", type: "bytes32" },
      { name: "sig", type: "bytes" },
      { name: "index", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isAccepted",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "leaf", type: "bytes32" },
      { name: "index", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "bond", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "batches",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "root", type: "bytes32" },
      { name: "aggregator", type: "address" },
      { name: "deadline", type: "uint64" },
      { name: "count", type: "uint32" },
      { name: "slashed", type: "bool" },
      { name: "finalized", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "BatchSubmitted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "aggregator", type: "address", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "count", type: "uint32", indexed: false },
      { name: "dataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchSlashed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "challenger", type: "address", indexed: true },
      { name: "index", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "BatchFinalized", inputs: [{ name: "id", type: "uint256", indexed: true }] },
  ...["WrongBond", "UnknownBatch", "WindowClosed", "WindowOpen", "AlreadySlashed", "AlreadyFinalized", "NotInBatch", "SignatureValid", "TransferFailed"].map(
    (name) => ({ type: "error" as const, name, inputs: [] as const }),
  ),
] as const;
