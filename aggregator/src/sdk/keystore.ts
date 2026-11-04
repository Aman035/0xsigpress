// Crash-safe key state for a stateful hash-based (XMSS) key.
//
// Rule (RLN lesson): the next leaf index is persisted durably BEFORE the signature exists.
// sign() = read nextIndex i -> write {nextIndex: i + 1} to a temp file -> fsync -> rename over the state
// file -> fsync the directory -> only then compute and return the signature for leaf i.
// A crash at any point either leaves the old state (no signature was made) or the new state (leaf i is
// burned, maybe unused). It can never hand out leaf i twice. Burned leaves are the price of safety.
//
// The state file holds no secrets: {version, root, height, nextIndex}. The seed stays with the caller.
// A lock file (<path>.lock, holding the owner pid) stops two processes using the same state at once.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { Hex } from "viem";
import { xmssSignUnsafe, type XMSSKey, type XMSSPublicKey, type XMSSSignature } from "./xmss.ts";

export interface KeyState {
  version: 1;
  root: Hex;
  height: number;
  nextIndex: number;
}

export class KeyExhaustedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "KeyExhaustedError";
  }
}

export class KeyStoreLockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "KeyStoreLockedError";
  }
}

export interface KeyStoreOptions {
  /** Called once per sign() when remaining leaves (after this sign) <= warnAt. Default: console.warn. */
  onWarn?: (remaining: number, state: Readonly<KeyState>) => void;
  /** Warn threshold in remaining leaves. Default: max(1, 10% of capacity). */
  warnAt?: number;
  /**
   * Leaves held back for a final migration / rotation op (sign with { final: true }). Default 1, so a key
   * can never be fully spent without leaving one signature to move funds to a fresh key.
   */
  reserve?: number;
}

function fsyncDir(dir: string): void {
  // Makes the rename durable. Not supported on every platform (e.g. Windows); best effort there.
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeDurable(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

function parseState(raw: string, path: string): KeyState {
  const s = JSON.parse(raw) as Partial<KeyState>;
  if (
    s.version !== 1 ||
    typeof s.root !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(s.root) ||
    !Number.isInteger(s.height) ||
    !Number.isInteger(s.nextIndex) ||
    s.nextIndex! < 0 ||
    s.nextIndex! > 2 ** s.height!
  ) {
    throw new Error(`corrupt key state in ${path}`);
  }
  return s as KeyState;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      fsyncSync(fd);
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && pidAlive(owner)) {
        throw new KeyStoreLockedError(`key state ${lockPath} is locked by running process ${owner}`);
      }
      if (owner === process.pid) throw new KeyStoreLockedError(`key state ${lockPath} is already open in this process`);
      // Stale lock from a crashed process: safe to take over, the state file itself is always consistent.
      unlinkSync(lockPath);
    }
  }
  throw new KeyStoreLockedError(`could not lock ${lockPath}`);
}

export class KeyStore {
  readonly path: string;
  private readonly lockPath: string;
  private state: KeyState;
  private closed = false;
  private readonly onWarn: NonNullable<KeyStoreOptions["onWarn"]>;
  private readonly warnAt: number;
  readonly reserve: number;

  private constructor(path: string, state: KeyState, opts: KeyStoreOptions) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.state = state;
    const cap = 2 ** state.height;
    this.warnAt = opts.warnAt ?? Math.max(1, Math.floor(cap / 10));
    this.reserve = opts.reserve ?? 1;
    if (!Number.isInteger(this.reserve) || this.reserve < 0 || this.reserve >= cap) throw new Error("bad reserve");
    this.onWarn =
      opts.onWarn ??
      ((remaining) => console.warn(`sigpress keystore: only ${remaining} of ${cap} signatures left for ${state.root}; rotate soon`));
  }

  /** Create a new state file for a fresh key (fails if one already exists). */
  static create(path: string, pub: XMSSPublicKey, opts: KeyStoreOptions = {}): KeyStore {
    if (existsSync(path)) throw new Error(`key state already exists at ${path}; use KeyStore.open`);
    const lockPath = `${path}.lock`;
    acquireLock(lockPath);
    try {
      const state: KeyState = { version: 1, root: pub.root, height: pub.height, nextIndex: 0 };
      writeDurable(path, JSON.stringify(state));
      return new KeyStore(path, state, opts);
    } catch (e) {
      unlinkSync(lockPath);
      throw e;
    }
  }

  /** Open an existing state file. Takes over a lock left by a crashed process. */
  static open(path: string, opts: KeyStoreOptions = {}): KeyStore {
    const lockPath = `${path}.lock`;
    acquireLock(lockPath);
    try {
      return new KeyStore(path, parseState(readFileSync(path, "utf8"), path), opts);
    } catch (e) {
      unlinkSync(lockPath);
      throw e;
    }
  }

  get root(): Hex {
    return this.state.root;
  }
  get height(): number {
    return this.state.height;
  }
  get capacity(): number {
    return 2 ** this.state.height;
  }
  get nextIndex(): number {
    return this.state.nextIndex;
  }
  /** Leaves left, including the reserved ones. */
  get remaining(): number {
    return this.capacity - this.state.nextIndex;
  }

  /**
   * Durably reserve the next leaf index and return it. After this returns, the index is burned whether
   * or not a signature is ever made with it. `final` allows using the reserved leaves.
   */
  reserveIndex(opts: { final?: boolean } = {}): number {
    if (this.closed) throw new Error("keystore is closed");
    const i = this.state.nextIndex;
    const floor = opts.final ? 0 : this.reserve;
    if (this.capacity - i <= floor) {
      throw new KeyExhaustedError(
        this.capacity - i === 0
          ? `key ${this.state.root} is exhausted (${this.capacity} signatures used)`
          : `key ${this.state.root} has only ${this.capacity - i} reserved leaf(s) left; sign the migration op with { final: true }`,
      );
    }
    const next: KeyState = { ...this.state, nextIndex: i + 1 };
    writeDurable(this.path, JSON.stringify(next)); // persist BEFORE any signature exists
    this.state = next;
    const remaining = this.capacity - next.nextIndex;
    if (remaining <= this.warnAt) this.onWarn(remaining, next);
    return i;
  }

  /**
   * Persist the next index, then sign with that leaf. Never signs two messages with one leaf.
   * `m` is the message, or a function of the leaf index (for messages that commit to it, as XMSSAccount's do).
   */
  sign(key: XMSSKey, m: Hex | ((leafIndex: number) => Hex), opts: { final?: boolean } = {}): XMSSSignature {
    if (key.root.toLowerCase() !== this.state.root.toLowerCase() || key.height !== this.state.height) {
      throw new Error("key does not match this key state (root/height)");
    }
    const i = this.reserveIndex(opts);
    return xmssSignUnsafe(key, i, typeof m === "function" ? m(i) : m);
  }

  /** Release the lock. The state on disk is already up to date. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
  }
}
