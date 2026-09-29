#!/usr/bin/env bash
# Proof that the site turns notebooks into pages generically, from the notebooks themselves, and
# reproducibly: it runs the deploy's notebook pipeline end to end on clean snapshots and checks
# the result against git and the built site. Nothing is pre-rendered and no cache is reused.
#
#   tools/notebooks/prove.sh [--website DIR] [--vault DIR] [--vault-private DIR] [--work DIR]
#
# Needs git, node/npm (the website's node_modules installed), quarto and wolframscript with a
# licensed Wolfram Engine (the compute host). About 20-30 minutes; needs 2 license processes free
# for none of that time (one kernel + 2 subkernels at a time).
#
# What it does, in the work directory (default ~/.cache/hafezi-notebooks-proof/<time>):
#   1. snapshots website, vault and vault-private as git clones of their HEAD; uncommitted local
#      changes are committed into the snapshot (never into the source repo) and reported as such
#   2. adds a Wolfram notebook written from scratch (tests/make-notebook.wls) to the private vault
#      snapshot, so the proof is not about any one book
#   3. stage 1 twice, each from an empty cache: the exact command of the deploy's `notebooks` job
#   4. the member build from the first render, as the deploy's `deploy` job runs it
#   5. a warm deploy: one Wolfram and one Jupyter notebook changed; stage 1 and the page step run
#      again with the caches the deploy keeps, and only those two may re-render
#   6. verify-proof.mjs: every committed notebook has a page, every figure/link resolves, the two
#      from-scratch renders are byte-identical, the made-up notebook renders every output kind, and
#      the warm deploy re-rendered only what changed, leaving every other page byte-identical
# Results: <work>/PROOF.md, proof-report.json, notebook-assets.sha256, logs/. Exit 0 = proven.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSITE="$(cd "$here/../.." && pwd)"
VAULT="${VAULT:-$(dirname "$WEBSITE")/vault}"
VAULT_PRIVATE="${VAULT_PRIVATE:-$(dirname "$WEBSITE")/vault-private}"
WORK="$HOME/.cache/hafezi-notebooks-proof/$(date +%Y%m%d-%H%M%S)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --website) WEBSITE="$(cd "$2" && pwd)"; shift 2 ;;
    --vault) VAULT="$(cd "$2" && pwd)"; shift 2 ;;
    --vault-private) VAULT_PRIVATE="$(cd "$2" && pwd)"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
for tool in git node npm quarto wolframscript; do
  command -v "$tool" >/dev/null || { echo "$tool not found on PATH" >&2; exit 1; }
done
[[ -d "$WEBSITE/node_modules" ]] || { echo "run npm ci in $WEBSITE first" >&2; exit 1; }
[[ -e "$WORK" ]] && { echo "$WORK exists" >&2; exit 1; }
mkdir -p "$WORK/src" "$WORK/tmp" "$WORK/logs"
export TMPDIR="$WORK/tmp"   # the build stages large files; /tmp may be a small tmpfs
log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
declare -A TIMES
now() { date +%s; }

# Wolfram renders on this machine take turns on the license through this lock, when the host has
# it: a deploy's render job waits while the proof holds it (render-notebooks.mjs skips taking it
# again when WOLFRAM_LOCK_HELD is set).
if [[ -e /run/lock/hafezi-wolfram.lock ]]; then
  exec 9</run/lock/hafezi-wolfram.lock
  log "wait for the Wolfram lock (a deploy's render may hold it)"
  flock -w 3600 9 || { echo "the Wolfram lock stayed held for an hour" >&2; exit 1; }
  export WOLFRAM_LOCK_HELD=1
fi

# ---------- 1. snapshots ----------
snapshots="{}"
snapshot() { # name source
  local name="$1" src="$2" dst="$WORK/src/$1" head dirty=false snap
  log "snapshot $name ($src)"
  git clone -q --shared "$src" "$dst"
  head="$(git -C "$src" rev-parse HEAD)"
  git -C "$dst" checkout -q --detach "$head"
  # Local changes, tracked or new (not ignored), become one commit in the snapshot only.
  while IFS= read -r -d '' f; do
    if [[ -e "$src/$f" || -L "$src/$f" ]]; then
      mkdir -p "$dst/$(dirname "$f")"; cp -a "$src/$f" "$dst/$f"
    else
      rm -f "$dst/$f"
    fi
  done < <(git -C "$src" ls-files -z --modified --deleted --others --exclude-standard)
  if [[ -n "$(git -C "$dst" status --porcelain)" ]]; then
    dirty=true
    git -C "$dst" add -A
    git -C "$dst" -c user.name=prove.sh -c user.email=prove@localhost commit -q -m "proof snapshot of uncommitted changes in $src"
  fi
  snap="$(git -C "$dst" rev-parse HEAD)"
  snapshots="$(node -e 'const o=JSON.parse(process.argv[1]); o[process.argv[2]]={source:process.argv[3],head:process.argv[4],dirty:process.argv[5]==="true",snapshot:process.argv[6]}; console.log(JSON.stringify(o))' \
    "$snapshots" "$name" "$src" "$head" "$dirty" "$snap")"
}
snapshot website "$WEBSITE"
snapshot vault "$VAULT"
snapshot vault-private "$VAULT_PRIVATE"
# The website snapshot uses the installed dependencies (the deploy runs npm ci from the same lockfile).
for dep in node_modules worker/node_modules .quartz; do
  [[ -e "$WEBSITE/$dep" ]] && ln -s "$WEBSITE/$dep" "$WORK/src/website/$dep"
done

# ---------- 2. a notebook that has nothing to do with any book ----------
log "write a notebook from scratch into the private vault snapshot"
mkdir -p "$WORK/src/vault-private/proof"
wolframscript -file "$WORK/src/website/tools/notebooks/tests/make-notebook.wls" \
  "$WORK/src/vault-private/proof/ring-resonator-notes.nb" > "$WORK/logs/make-notebook.log" 2>&1
git -C "$WORK/src/vault-private" add proof
git -C "$WORK/src/vault-private" -c user.name=prove.sh -c user.email=prove@localhost commit -q -m "proof: a notebook written from scratch"
snapshots="$(node -e 'const o=JSON.parse(process.argv[1]); o["vault-private"].snapshot=process.argv[2]; console.log(JSON.stringify(o))' \
  "$snapshots" "$(git -C "$WORK/src/vault-private" rev-parse HEAD)")"
echo "$snapshots" > "$WORK/snapshots.json"

node -e 'const fs=require("fs"); const [wl, q, n] = process.argv.slice(1);
  const v = /\$ExporterVersion = "([^"]+)"/.exec(fs.readFileSync(process.argv[4], "utf8"))[1];
  fs.writeFileSync(process.argv[5], JSON.stringify({wolfram: wl, renderer: v, quarto: q, node: n}))' \
  "$(wolframscript -code '$VersionNumber' | tail -1)" "$(quarto --version)" "$(node --version)" \
  "$WORK/src/website/tools/notebooks/WolframNotebook.wl" "$WORK/versions.json"

# ---------- 3. stage 1, twice, from empty caches (the deploy's notebooks job) ----------
cd "$WORK/src/website"
for run in a b; do
  log "stage 1, run $run, empty cache"
  t=$(now)
  NOTEBOOK_CACHE="$WORK/cache-$run" node tools/notebooks/render-notebooks.mjs stage1 \
    --root ../vault/content --root ../vault-private --out "$WORK/renders-$run" \
    > "$WORK/logs/stage1-$run.log" 2>&1 || { tail -20 "$WORK/logs/stage1-$run.log"; echo "stage 1 run $run failed (see logs)"; }
  TIMES[stage1_$run]=$(( $(now) - t ))
  grep -E "^done:" "$WORK/logs/stage1-$run.log" || true
done

# ---------- 4. the member build from run a's renders (the deploy job) ----------
log "member build (stage 2 + .ipynb + Quartz) from run a"
t=$(now)
NOTEBOOK_RENDERS="$WORK/renders-a" NOTEBOOK_CACHE="$WORK/cache-post" NOTEBOOK_REPORT="$WORK/notebook-report.json" \
  VAULT_PUBLIC_DIR=../vault/content VAULT_PRIVATE_DIR=../vault-private \
  npm run build:members > "$WORK/logs/build.log" 2>&1 || { tail -30 "$WORK/logs/build.log"; echo "the member build failed (see logs)"; }
TIMES[build]=$(( $(now) - t ))
grep -E "render-notebooks:" "$WORK/logs/build.log" || true

# ---------- 5. a warm deploy: one notebook of each kind changed ----------
# On a separate clone of the vault snapshot, so the checks above stay about the cold deploy.
log "warm deploy: one Wolfram and one Jupyter notebook changed"
WARM="$WORK/src/vault-private-warm"
git clone -q --shared "$WORK/src/vault-private" "$WARM"
wolframscript -file "$WORK/src/website/tools/notebooks/tests/make-notebook.wls" \
  "$WARM/proof/ring-resonator-notes.nb" warm-deploy >> "$WORK/logs/make-notebook.log" 2>&1
IPYNB="$(git -C "$WARM" ls-files '*.ipynb' | grep -v '^\.' | head -1)"
node -e 'const fs = require("fs"); const f = process.argv[1]; const nb = JSON.parse(fs.readFileSync(f, "utf8"));
  nb.cells.push({ cell_type: "markdown", id: "prove-warm", metadata: {}, source: ["Added by prove.sh: a warm deploy re-renders this notebook only."] });
  fs.writeFileSync(f, JSON.stringify(nb, null, 1))' "$WARM/$IPYNB"
git -C "$WARM" -c user.name=prove.sh -c user.email=prove@localhost commit -qam "proof: change one notebook of each kind"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ wolfram: "resources/proof/ring-resonator-notes.nb", jupyter: "resources/" + process.argv[2] }))' \
  "$WORK/warm-changed.json" "$IPYNB"
t=$(now)
NOTEBOOK_CACHE="$WORK/cache-a" node tools/notebooks/render-notebooks.mjs stage1 \
  --root ../vault/content --root ../vault-private-warm --out "$WORK/renders-warm" \
  > "$WORK/logs/stage1-warm.log" 2>&1 || { tail -20 "$WORK/logs/stage1-warm.log"; echo "warm stage 1 failed (see logs)"; }
TIMES[stage1_warm]=$(( $(now) - t ))
grep -E "^done:" "$WORK/logs/stage1-warm.log" || true

node -e 'const t={}; for (const kv of process.argv.slice(2)) { const [k,v]=kv.split("="); t[k]=Number(v) }
  require("fs").writeFileSync(process.argv[1], JSON.stringify(t))' \
  "$WORK/timings.json" "stage1_a=${TIMES[stage1_a]}" "stage1_b=${TIMES[stage1_b]}" "build=${TIMES[build]}" "stage1_warm=${TIMES[stage1_warm]}"

# ---------- 6. verify ----------
log "verify"
set +e
node tools/notebooks/verify-proof.mjs --work "$WORK" --site "$WORK/src/website/.cache/private-site"
status=$?
set -e
echo
echo "Work directory: $WORK (PROOF.md, proof-report.json, notebook-assets.sha256, logs/)"
exit $status
