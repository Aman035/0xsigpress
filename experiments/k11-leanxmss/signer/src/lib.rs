//! Shared pieces of the K11 leanXMSS signer: hex, the key file, the KeyStore-compatible state file and
//! its lock, and the batch file the provers read.
//!
//! Scheme: `crates/xmss` of Client-Side-Proving/leanVM `recursive-verifier` @ fb0909d (Apache-2.0),
//! i.e. leanXMSS over KoalaBear with Poseidon1 (16-wide compression), WOTS v = 42 chains of length 8,
//! a 2^32-slot Merkle tree (LOG_LIFETIME = 32), 32-byte SSZ public keys and 1,208-byte SSZ signatures.
//! A key is active for a slot range [activationSlot, activationSlot + 2^logSlots).
use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use ssz::{Decode, Encode};
use xmss::{XmssPublicKey, XmssSecretKey, XmssSignature};

pub type Res<T> = Result<T, Box<dyn Error>>;

pub const SCHEME: &str = "leanxmss-koalabear-poseidon1/leanVM-recursive-verifier-fb0909d";
pub const BATCH_SCHEMA: &str = "sigpress-leanxmss-batch-v1";
pub const MAX_LOG_SLOTS: u32 = 24;

// ---------- hex ----------

pub fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + 2 * bytes.len());
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn from_hex(s: &str) -> Res<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.into()))
        .collect()
}

pub fn hex32(s: &str) -> Res<[u8; 32]> {
    let v = from_hex(s)?;
    v.try_into().map_err(|_| "expected 32 bytes of hex".into())
}

pub fn pk_from_hex(s: &str) -> Res<XmssPublicKey> {
    XmssPublicKey::from_ssz_bytes(&from_hex(s)?).map_err(|e| format!("bad public key: {e:?}").into())
}

pub fn sig_from_hex(s: &str) -> Res<XmssSignature> {
    XmssSignature::from_ssz_bytes(&from_hex(s)?).map_err(|e| format!("bad signature: {e:?}").into())
}

pub fn pk_hex(pk: &XmssPublicKey) -> String {
    to_hex(&pk.as_ssz_bytes())
}

pub fn sig_hex(sig: &XmssSignature) -> String {
    to_hex(&sig.as_ssz_bytes())
}

// ---------- durable writes ----------

pub fn fsync_dir(dir: &Path) {
    if let Ok(f) = File::open(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }) {
        let _ = f.sync_all();
    }
}

/// tmp file -> fsync -> rename over `path` -> fsync the directory (same rule as keystore.ts).
pub fn write_durable(path: &Path, data: &[u8], mode: u32) -> Res<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().ok_or("bad path")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    {
        let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    fsync_dir(dir);
    Ok(())
}

// ---------- key file ----------

/// The key file. Holds the secret seed: keep it 0600 and out of backups that could be restored.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub scheme: String,
    pub version: u32,
    pub seed: String,
    pub activation_slot: u32,
    pub log_slots: u32,
    pub public_key: String,
    /// postcard(XmssSecretKey): seed, slot range and the top tree, so loading skips the full keygen.
    pub secret_key: String,
}

pub struct LoadedKey {
    pub file: KeyFile,
    pub pk: XmssPublicKey,
    pub sk: XmssSecretKey,
}

pub fn keygen(seed: [u8; 32], activation_slot: u32, log_slots: u32) -> Res<LoadedKey> {
    if !(1..=MAX_LOG_SLOTS).contains(&log_slots) {
        return Err(format!("log-slots must be in 1..={MAX_LOG_SLOTS}").into());
    }
    let (pk, sk) = xmss::xmss_key_gen_from_seed(seed, u64::from(activation_slot), 1u64 << log_slots)
        .map_err(|e| format!("keygen: {e}"))?;
    let file = KeyFile {
        scheme: SCHEME.into(),
        version: 1,
        seed: to_hex(&seed),
        activation_slot,
        log_slots,
        public_key: pk_hex(&pk),
        secret_key: to_hex(&postcard::to_allocvec(&sk)?),
    };
    Ok(LoadedKey { file, pk, sk })
}

pub fn load_key(path: &Path) -> Res<LoadedKey> {
    let file: KeyFile = serde_json::from_slice(&fs::read(path)?)?;
    if file.scheme != SCHEME || file.version != 1 {
        return Err(format!("{}: unsupported key scheme/version", path.display()).into());
    }
    let sk: XmssSecretKey = postcard::from_bytes(&from_hex(&file.secret_key)?)?;
    let pk = pk_from_hex(&file.public_key)?;
    if sk.public_key() != pk {
        return Err("key file: secret key does not match public key".into());
    }
    let range = sk.activation_slots();
    if *range.start() != file.activation_slot
        || u64::from(*range.end()) + 1 != u64::from(file.activation_slot) + (1u64 << file.log_slots)
    {
        return Err("key file: slot range does not match activationSlot/logSlots".into());
    }
    Ok(LoadedKey { file, pk, sk })
}

// ---------- state file (same JSON as aggregator/src/sdk/keystore.ts) ----------

/// `{version: 1, root, height, nextIndex}`. root = the 32-byte SSZ public key, height = logSlots,
/// index i <-> slot activationSlot + i.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub version: u32,
    pub root: String,
    pub height: u32,
    pub next_index: u64,
}

pub fn read_state(path: &Path) -> Res<State> {
    let s: State = serde_json::from_slice(&fs::read(path)?)?;
    if s.version != 1 || s.next_index > (1u64 << s.height) {
        return Err(format!("corrupt key state in {}", path.display()).into());
    }
    Ok(s)
}

pub fn lock_path(state: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", state.display()))
}

/// Sidecar written by this CLI before each signature: the last (index, message) it signed.
pub fn ledger_path(state: &Path) -> PathBuf {
    PathBuf::from(format!("{}.leanxmss-signed", state.display()))
}

#[derive(Serialize, Deserialize)]
pub struct Ledger {
    pub index: u64,
    pub message: String,
}

fn pid_alive(pid: i32) -> bool {
    // kill(pid, 0): 0 = alive, EPERM = alive but not ours.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn lock_owner(lock: &Path) -> Option<i32> {
    fs::read_to_string(lock).ok()?.trim().parse().ok()
}

/// Same protocol as keystore.ts: create `<state>.lock` exclusively holding our pid; take over a lock
/// whose owner is dead; refuse one whose owner is alive.
pub fn acquire_lock(lock: &Path) -> Res<()> {
    use std::os::unix::fs::OpenOptionsExt;
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).mode(0o600).open(lock) {
            Ok(mut f) => {
                f.write_all(std::process::id().to_string().as_bytes())?;
                f.sync_all()?;
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Some(owner) = lock_owner(lock)
                    && owner > 0
                    && pid_alive(owner)
                {
                    return Err(format!("key state {} is locked by running process {owner}", lock.display()).into());
                }
                fs::remove_file(lock)?;
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(format!("could not lock {}", lock.display()).into())
}

// ---------- signature and batch files ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SignatureFile {
    pub scheme: String,
    pub public_key: String,
    pub slot: u32,
    pub index: u64,
    pub message: String,
    pub signature: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchSigner {
    pub public_key: String,
    pub signature: String,
}

/// What the provers read: every signer signs the same 32-byte `message` at the same `slot`
/// (leanVM single-message aggregation).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchFile {
    pub schema: String,
    pub scheme: String,
    pub message: String,
    pub slot: u32,
    pub signers: Vec<BatchSigner>,
}

pub struct Batch {
    pub message: [u8; 32],
    pub slot: u32,
    pub raw: Vec<(XmssPublicKey, XmssSignature)>,
}

/// Parse a batch file. With `check`, every signature is verified natively (xmss_verify) and duplicate
/// signers are rejected.
pub fn read_batch(path: &Path, check: bool) -> Res<Batch> {
    let f: BatchFile = serde_json::from_slice(&fs::read(path)?)?;
    if f.schema != BATCH_SCHEMA || f.scheme != SCHEME {
        return Err(format!("{}: not a {BATCH_SCHEMA} batch for {SCHEME}", path.display()).into());
    }
    let message = hex32(&f.message)?;
    let mut raw = Vec::with_capacity(f.signers.len());
    for (i, s) in f.signers.iter().enumerate() {
        let pk = pk_from_hex(&s.public_key)?;
        let sig = sig_from_hex(&s.signature)?;
        if check {
            xmss::xmss_verify(&pk, f.slot, &message, &sig).map_err(|e| format!("signer {i}: {e}"))?;
        }
        raw.push((pk, sig));
    }
    if check {
        let mut pks: Vec<_> = raw.iter().map(|(pk, _)| pk.clone()).collect();
        pks.sort();
        let n = pks.len();
        pks.dedup();
        if pks.len() != n {
            return Err("duplicate signer in batch".into());
        }
    }
    Ok(Batch { message, slot: f.slot, raw })
}
