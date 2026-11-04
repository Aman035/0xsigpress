#!/usr/bin/env bash
# Run a command under the shared prover lock (16 GB machine shared with other jobs).
LOCK=/private/tmp/claude-501/sigpress-prover.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 10; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
"$@"
