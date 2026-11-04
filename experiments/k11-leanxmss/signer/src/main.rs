//! sigpress-leanxmss: keygen / sign / verify / export-batch / prove-batch for the leanXMSS variant that the
//! vendored leanVM (`recursive-verifier` @ fb0909d) aggregation program verifies.
//!
//! Output: one JSON object on stdout. Errors: message on stderr, exit 2. `verify` exits 1 on an invalid
//! signature. Research code (K11), MIT; the cryptography is the vendored Apache-2.0 `xmss` crate.
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use clap::{Parser, Subcommand};
use lean_prover::{
    WhirExecutionProfile, prove_execution::prove_execution_with_profile,
    verify_execution::verify_execution_with_profile,
};
use serde_json::{Value, json};
use sigpress_leanxmss::*;

#[derive(Parser)]
#[command(name = "sigpress-leanxmss", about = "leanXMSS (KoalaBear/Poseidon1) signer for Sigpress validity proofs")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Deterministic keygen from a 32-byte secret seed; writes the key file (0600, contains the seed).
    Keygen {
        #[arg(long)]
        seed: String,
        #[arg(long)]
        out: PathBuf,
        /// The key signs 2^log_slots slots.
        #[arg(long, default_value_t = 10)]
        log_slots: u32,
        /// First slot the key can sign.
        #[arg(long, default_value_t = 0)]
        activation_slot: u32,
        /// Also create a fresh KeyStore-format state file here (fails if it exists).
        #[arg(long)]
        state: Option<PathBuf>,
    },
    /// Print the public key and slot range of a key file.
    Pubkey {
        #[arg(long)]
        key: PathBuf,
    },
    /// Stateful sign of a 32-byte message with leaf `index` (slot = activationSlot + index).
    ///
    /// Without --reserved: takes `<state>.lock`, refuses index < nextIndex, durably writes
    /// nextIndex = index + 1, then signs. With --reserved: the caller (our parent process) must hold
    /// `<state>.lock` and must already have persisted nextIndex = index + 1 (keystore.ts reserveIndex).
    /// Both modes also durably record (index, message) in `<state>.leanxmss-signed` before signing and
    /// refuse an older index or the same index with a different message.
    Sign {
        #[arg(long)]
        key: PathBuf,
        #[arg(long)]
        state: PathBuf,
        #[arg(long)]
        index: u64,
        #[arg(long)]
        msg: String,
        #[arg(long)]
        reserved: bool,
        /// Write the signature JSON here as well as stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Verify a signature (from --sig-file, or --pubkey/--slot/--msg/--sig).
    Verify {
        #[arg(long)]
        sig_file: Option<PathBuf>,
        #[arg(long)]
        pubkey: Option<String>,
        #[arg(long)]
        slot: Option<u32>,
        #[arg(long)]
        msg: Option<String>,
        #[arg(long)]
        sig: Option<String>,
    },
    /// Collect signature files over one (message, slot) into a batch file for the provers. With
    /// --per-signer: each signature keeps its own message (all at one slot), for the binding-v2 runner.
    ExportBatch {
        #[arg(long, required_unless_present = "per_signer")]
        msg: Option<String>,
        #[arg(long, conflicts_with = "msg")]
        per_signer: bool,
        #[arg(long)]
        slot: u32,
        /// Signature JSON files (from `sign --out`), repeatable.
        #[arg(long = "sig", required = true)]
        sigs: Vec<PathBuf>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Prove one batch with the vendored leanVM aggregation program and verify the proof natively.
    ///
    /// With --profile (e.g. experiments/k10-terminal/profiles/sigpress_c1.json) the proof uses that
    /// file's `direct` WhirExecutionProfile, exactly as the K10 terminal chain proves its children.
    /// Without it: leanVM's own aggregate_single_message_signatures (default WHIR config, rate 1/2) and
    /// verify_single_message_aggregate. Heavy: run under the shared prover lock.
    ProveBatch {
        #[arg(long)]
        batch: PathBuf,
        #[arg(long)]
        profile: Option<PathBuf>,
        /// Skip the native xmss_verify pre-check (to test that the leanVM program itself rejects).
        #[arg(long)]
        no_precheck: bool,
        /// Pad child tables: "execution,extension_op,poseidon16" log rows (K10's SIGPRESS_MIN_LOG_ROWS).
        #[arg(long)]
        min_log_rows: Option<String>,
        #[arg(long)]
        proof_out: Option<PathBuf>,
    },
}

fn main() {
    let cli = Cli::parse();
    // Proving recurses deeply; mirror the K10 runner (64 MB work thread).
    let result = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(move || run(cli).map_err(|e| e.to_string()))
        .unwrap()
        .join();
    match result {
        Ok(Ok(code)) => std::process::exit(code),
        Ok(Err(e)) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("error: panicked");
            std::process::exit(3);
        }
    }
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string(v).unwrap());
}

fn run(cli: Cli) -> Res<i32> {
    match cli.cmd {
        Cmd::Keygen {
            seed,
            out,
            log_slots,
            activation_slot,
            state,
        } => {
            if out.exists() {
                return Err(format!("{} exists; refusing to overwrite a key", out.display()).into());
            }
            if let Some(s) = &state
                && s.exists()
            {
                return Err(format!("key state already exists at {}", s.display()).into());
            }
            let t = Instant::now();
            let k = keygen(hex32(&seed)?, activation_slot, log_slots)?;
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            write_durable(&out, &serde_json::to_vec_pretty(&k.file)?, 0o600)?;
            if let Some(s) = &state {
                let st = State {
                    version: 1,
                    root: k.file.public_key.clone(),
                    height: log_slots,
                    next_index: 0,
                };
                write_durable(s, serde_json::to_string(&st)?.as_bytes(), 0o600)?;
            }
            print(&json!({
                "publicKey": k.file.public_key,
                "activationSlot": activation_slot,
                "logSlots": log_slots,
                "keygenMs": ms,
                "keyFileBytes": fs::metadata(&out)?.len(),
            }));
            Ok(0)
        }
        Cmd::Pubkey { key } => {
            let k = load_key(&key)?;
            print(&json!({
                "publicKey": k.file.public_key,
                "activationSlot": k.file.activation_slot,
                "logSlots": k.file.log_slots,
                "scheme": SCHEME,
            }));
            Ok(0)
        }
        Cmd::Sign {
            key,
            state,
            index,
            msg,
            reserved,
            out,
        } => sign(&key, &state, index, &msg, reserved, out.as_deref()),
        Cmd::Verify {
            sig_file,
            pubkey,
            slot,
            msg,
            sig,
        } => {
            let (pk, slot, m, s) = if let Some(f) = sig_file {
                let f: SignatureFile = serde_json::from_slice(&fs::read(f)?)?;
                (f.public_key, f.slot, f.message, f.signature)
            } else {
                (
                    pubkey.ok_or("--pubkey")?,
                    slot.ok_or("--slot")?,
                    msg.ok_or("--msg")?,
                    sig.ok_or("--sig")?,
                )
            };
            let parsed = pk_from_hex(&pk).and_then(|pk| Ok((pk, sig_from_hex(&s)?, hex32(&m)?)));
            let t = Instant::now();
            let r = match parsed {
                Ok((pk, sig, m)) => xmss::xmss_verify(&pk, slot, &m, &sig).map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            match r {
                Ok(()) => {
                    print(&json!({"valid": true, "verifyMs": ms}));
                    Ok(0)
                }
                Err(e) => {
                    print(&json!({"valid": false, "error": e}));
                    Ok(1)
                }
            }
        }
        Cmd::ExportBatch { msg, per_signer, slot, sigs, out } => {
            let message = msg.as_deref().map(hex32).transpose()?;
            let mut signers = Vec::new();
            for p in &sigs {
                let f: SignatureFile = serde_json::from_slice(&fs::read(p)?)?;
                if f.scheme != SCHEME {
                    return Err(format!("{}: wrong scheme", p.display()).into());
                }
                let m = hex32(&f.message)?;
                if f.slot != slot || message.is_some_and(|b| b != m) {
                    return Err(format!("{}: signs a different (message, slot)", p.display()).into());
                }
                let pk = pk_from_hex(&f.public_key)?;
                let sig = sig_from_hex(&f.signature)?;
                xmss::xmss_verify(&pk, slot, &m, &sig).map_err(|e| format!("{}: {e}", p.display()))?;
                signers.push((pk, sig, m));
            }
            // Canonical order: sorted by public key (the aggregation sorts the same way).
            signers.sort_by(|a, b| a.0.cmp(&b.0));
            let n = signers.len();
            signers.dedup_by(|a, b| a.0 == b.0);
            if signers.len() != n {
                return Err("duplicate signer (same public key twice)".into());
            }
            if n > rec_aggregation::MAX_XMSS_AGGREGATED {
                return Err(format!("{n} signers > MAX_XMSS_AGGREGATED {}", rec_aggregation::MAX_XMSS_AGGREGATED).into());
            }
            let batch = BatchFile {
                schema: BATCH_SCHEMA.into(),
                scheme: SCHEME.into(),
                message: message.map(|m| to_hex(&m)),
                slot,
                signers: signers
                    .iter()
                    .map(|(pk, sig, m)| BatchSigner {
                        public_key: pk_hex(pk),
                        signature: sig_hex(sig),
                        message: per_signer.then(|| to_hex(m)),
                    })
                    .collect(),
            };
            write_durable(&out, &serde_json::to_vec(&batch)?, 0o644)?;
            print(&json!({"signers": n, "message": batch.message, "perSigner": per_signer, "slot": slot, "bytes": fs::metadata(&out)?.len()}));
            Ok(0)
        }
        Cmd::ProveBatch {
            batch,
            profile,
            no_precheck,
            min_log_rows,
            proof_out,
        } => prove_batch(&batch, profile.as_deref(), !no_precheck, min_log_rows.as_deref(), proof_out.as_deref()),
    }
}

fn sign(key: &Path, state: &Path, index: u64, msg: &str, reserved: bool, out: Option<&Path>) -> Res<i32> {
    let message = hex32(msg)?;
    let k = load_key(key)?;
    let lock = lock_path(state);
    let mut took_lock = false;
    let result = (|| -> Res<SignatureFile> {
        let st = read_state(state)?;
        if st.root.to_lowercase() != k.file.public_key.to_lowercase() || st.height != k.file.log_slots {
            return Err("key does not match this key state (root/height)".into());
        }
        if index >= 1u64 << k.file.log_slots {
            return Err(format!("index {index} out of range for 2^{} slots", k.file.log_slots).into());
        }
        if reserved {
            let parent = std::os::unix::process::parent_id() as i32;
            if lock_owner(&lock) != Some(parent) {
                return Err("--reserved: the parent process must hold the state lock".into());
            }
            if st.next_index != index + 1 {
                return Err(format!(
                    "--reserved: index {index} is not the one just reserved (state nextIndex = {})",
                    st.next_index
                )
                .into());
            }
        } else {
            acquire_lock(&lock)?;
            took_lock = true;
            let st = read_state(state)?; // re-read under the lock
            if index < st.next_index {
                return Err(format!("index {index} already used or skipped (nextIndex = {})", st.next_index).into());
            }
            let next = State {
                next_index: index + 1,
                ..st
            };
            write_durable(state, serde_json::to_string(&next)?.as_bytes(), 0o600)?; // persist BEFORE signing
        }
        // Second, independent guard: the last (index, message) this CLI signed for this state file.
        let ledger = ledger_path(state);
        if let Ok(raw) = fs::read(&ledger) {
            let last: Ledger = serde_json::from_slice(&raw)?;
            let same_msg = hex32(&last.message)? == message;
            if index < last.index || (index == last.index && !same_msg) {
                return Err(format!(
                    "refusing: index {index} would reuse a one-time key (last signed index {})",
                    last.index
                )
                .into());
            }
        }
        let entry = Ledger {
            index,
            message: to_hex(&message),
        };
        write_durable(&ledger, serde_json::to_string(&entry)?.as_bytes(), 0o600)?;
        let slot = u32::try_from(u64::from(k.file.activation_slot) + index)?;
        let sig = xmss::xmss_sign(&k.sk, slot, &message).map_err(|e| format!("sign: {e}"))?;
        xmss::xmss_verify(&k.pk, slot, &message, &sig).map_err(|e| format!("self-check failed: {e}"))?;
        Ok(SignatureFile {
            scheme: SCHEME.into(),
            public_key: k.file.public_key.clone(),
            slot,
            index,
            message: to_hex(&message),
            signature: sig_hex(&sig),
        })
    })();
    if took_lock {
        let _ = fs::remove_file(&lock);
    }
    let f = result?;
    let bytes = serde_json::to_vec(&f)?;
    if let Some(o) = out {
        write_durable(o, &bytes, 0o644)?;
    }
    println!("{}", String::from_utf8(bytes)?);
    Ok(0)
}

fn prove_batch(
    batch: &Path,
    profile: Option<&Path>,
    precheck: bool,
    min_log_rows: Option<&str>,
    proof_out: Option<&Path>,
) -> Res<i32> {
    let b = read_batch(batch, precheck)?;
    let n = b.raw.len();
    rec_aggregation::init_aggregation_bytecode();
    let bytecode = rec_aggregation::get_aggregation_bytecode();
    let mut report = json!({
        "batch": batch.display().to_string(),
        "signers": n,
        "slot": b.slot,
        "message": to_hex(&b.message),
        "nativePrecheck": precheck,
    });
    if let Some(profile_path) = profile {
        let v: Value = serde_json::from_slice(&fs::read(profile_path)?)?;
        let direct: WhirExecutionProfile = serde_json::from_value(v["direct"].clone())?;
        direct.validate()?;
        let (public_input, mut witness, signers, _preimage) =
            rec_aggregation::prepare_raw_single_message_execution(b.raw, b.message, b.slot)?;
        if let Some(spec) = min_log_rows {
            let rows: Vec<usize> = spec.split(',').map(|s| s.trim().parse()).collect::<Result<_, _>>()?;
            if rows.len() != 3 {
                return Err("--min-log-rows needs three comma-separated log sizes".into());
            }
            witness.min_table_log_n_rows.insert(lean_vm::Table::execution(), rows[0]);
            witness.min_table_log_n_rows.insert(lean_vm::Table::extension_op(), rows[1]);
            witness.min_table_log_n_rows.insert(lean_vm::Table::poseidon16(), rows[2]);
        }
        let t = Instant::now();
        let proof = prove_execution_with_profile(bytecode, &public_input, &witness, &direct, false)
            .map_err(|e| format!("prove: {e}"))?;
        let prove_ms = t.elapsed().as_secs_f64() * 1000.0;
        let proof_bytes = postcard::to_allocvec(&proof.proof)?;
        let t = Instant::now();
        verify_execution_with_profile(bytecode, &public_input, proof.proof.clone(), &direct)
            .map_err(|e| format!("verify: {e:?}"))?;
        let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
        if let Some(p) = proof_out {
            write_durable(p, &proof_bytes, 0o644)?;
        }
        report["mode"] = json!("k10-direct-profile");
        report["profile"] = json!(profile_path.display().to_string());
        report["distinctSigners"] = json!(signers.len());
        report["publicInput"] = json!(public_input.iter().map(|x| backend::PrimeField32::as_canonical_u32(x)).collect::<Vec<_>>());
        report["proofBytes"] = json!(proof_bytes.len());
        report["proveMs"] = json!(prove_ms);
        report["verifyMs"] = json!(verify_ms);
        report["accepted"] = json!(true);
    } else {
        let t = Instant::now();
        let agg = rec_aggregation::aggregate_single_message_signatures(&[], b.raw, b.message, b.slot, 1)
            .map_err(|e| format!("aggregate: {e:?}"))?;
        let prove_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        rec_aggregation::verify_single_message_aggregate(&agg).map_err(|e| format!("verify: {e:?}"))?;
        let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
        let bytes = agg.to_bytes_without_pubkeys();
        if let Some(p) = proof_out {
            write_durable(p, &bytes, 0o644)?;
        }
        report["mode"] = json!("leanvm-default-aggregate");
        report["distinctSigners"] = json!(agg.info.pubkeys.len());
        report["aggregateBytesWithoutPubkeys"] = json!(bytes.len());
        report["proveMs"] = json!(prove_ms);
        report["verifyMs"] = json!(verify_ms);
        report["accepted"] = json!(true);
    }
    print(&report);
    Ok(0)
}
