#!/bin/bash
# check-architecture.sh — mechanical architecture guard (TECH-DEBT-PLAN item 0).
# Runs dependency-cruiser for module graph rules (boundaries, cycles, shims)
# and targeted AST/syntax checks for code-level smells (|| 0, env scatter, any ratchet).
set -uo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE="scripts/architecture-baseline.txt"
ALLOWLIST_FILE="scripts/architecture-allowlist.txt"
WRITE_BASELINE=0
[ "${1:-}" = "--write-baseline" ] && WRITE_BASELINE=1

echo "===> Step 1: Running dependency-cruiser (module boundaries & cycles)..."
if [ "$WRITE_BASELINE" = 1 ]; then
  npx depcruise-baseline src cli/src webview-ui/src --config .dependency-cruiser.js
  # Compact the baseline so a ~1.5k-entry file doesn't cost 5MB of repo footprint.
  node -e "const fs=require('fs');const p='.dependency-cruiser-known-violations.json';fs.writeFileSync(p,JSON.stringify(JSON.parse(fs.readFileSync(p))))"
  echo "Updated .dependency-cruiser-known-violations.json baseline (compacted)."
else
  if ! npx depcruise src cli/src webview-ui/src --config .dependency-cruiser.js --ignore-known; then
    echo "ERROR: dependency-cruiser detected NEW architectural boundary or cycle violations!"
    exit 1
  fi
fi

echo
echo "===> Step 2: Running code-level syntax & smell checks..."

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=generated --exclude-dir=proto --exclude-dir=dist --exclude-dir=out --exclude-dir=build)

check_one_tool_taxonomy() {
  # tool-set definitions live only in src/shared/tools.ts (plan item 4);
  # covers declarations and same-line re-exports (multiline export blocks remain uncheckable via grep)
  grep -rEn 'export (const|function|class) (FILE_EDIT_TOOLS|FILE_SAVE_TOOLS|TOOL_DESCRIPTIONS|READ_ONLY_TOOLS|MUTATING_TOOLS)\b' \
    "${EXCLUDES[@]}" --include='*.ts' src/ cli/src/ 2>/dev/null | grep -v '^src/shared/tools\.ts:'
  grep -rEn 'export \{[^}]*\b(FILE_EDIT_TOOLS|FILE_SAVE_TOOLS|TOOL_DESCRIPTIONS|READ_ONLY_TOOLS|MUTATING_TOOLS)\b' \
    "${EXCLUDES[@]}" --include='*.ts' src/ cli/src/ 2>/dev/null | grep -v '^src/shared/tools\.ts:'
}

check_no_numeric_or_default() {
  # `x || <number>` silently converts 0/NaN to the default; use ?? (plan item 7)
  grep -rEn '\|\|[[:space:]]*[0-9]+' "${EXCLUDES[@]}" --include='*.ts' src/ 2>/dev/null | grep -v '__tests__\|\.test\.ts'
}

check_env_centralized() {
  # file-level check: which core files read process.env directly (plan item 8)
  grep -rln 'process\.env' "${EXCLUDES[@]}" --include='*.ts' src/core/ 2>/dev/null | grep -v '__tests__\|\.test\.ts'
}

check_any_ratchet() {
  # diff-based, zero-tolerance: new `as any` / `: any` added in src code fails
  local base
  base=$(git merge-base HEAD origin/master 2>/dev/null || git merge-base HEAD master 2>/dev/null || true)
  [ -z "$base" ] && return 0
  git diff -U0 "$base" -- src cli/src webview-ui/src 2>/dev/null | \
    awk '/^\+\+\+ b\// { file = substr($0, 7); next }
         /^\+/ && ($0 ~ /as any([^A-Za-z0-9_]|$)/ || $0 ~ /: *any([^A-Za-z0-9_(]|$)/) {
           if (file !~ /\.test\.|__tests__/) print file ":" substr($0, 2)
         }'
}

SYNTAX_CHECKS="check_one_tool_taxonomy check_no_numeric_or_default check_env_centralized check_any_ratchet"

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT
FAILED=""

for id in $SYNTAX_CHECKS; do
  "$id" > "$TMPD/raw" 2>/dev/null || true
  sed -E 's/^([^:[:space:]]+):[0-9]+:[[:space:]]*/\1:/' "$TMPD/raw" | sed 's/[[:space:]]*$//' | LC_ALL=C sort -u > "$TMPD/norm"
  
  awk -F'\t' -v id="$id" '$1==id {print $2}' "$ALLOWLIST_FILE" 2>/dev/null > "$TMPD/allowed" || true
  if [ -s "$TMPD/allowed" ]; then
    grep -Fvf "$TMPD/allowed" "$TMPD/norm" > "$TMPD/active" || true
  else
    cp "$TMPD/norm" "$TMPD/active"
  fi

  if [ "$WRITE_BASELINE" = 1 ]; then
    awk -v id="$id" '{print id "\t" $0}' "$TMPD/active" >> "$TMPD/newbaseline"
    continue
  fi

  awk -F'\t' -v id="$id" '$1==id {print $2}' "$BASELINE_FILE" 2>/dev/null | LC_ALL=C sort -u > "$TMPD/base"
  new=$(comm -23 "$TMPD/active" "$TMPD/base" | wc -l | tr -d ' ')
  fixed=$(comm -13 "$TMPD/active" "$TMPD/base" | wc -l | tr -d ' ')
  total=$(wc -l < "$TMPD/active" | tr -d ' ')

  if [ "$new" -gt 0 ]; then
    FAILED="$FAILED $id"
    echo "[FAIL] $id — $new NEW violation(s) (baseline: $((total - new)) known)"
    comm -23 "$TMPD/active" "$TMPD/base" | sed 's/^/       + /'
  else
    echo "[PASS] $id — $total known-debt violation(s), 0 new"
  fi
  [ "$fixed" -gt 0 ] && echo "       ↳ $fixed baseline entr(ies) resolved — rerun with --write-baseline"
done

if [ "$WRITE_BASELINE" = 1 ]; then
  printf '# check_id\tpath:content — known-debt violations; shrink to zero as items land\n' > "$BASELINE_FILE"
  sort "$TMPD/newbaseline" >> "$BASELINE_FILE" 2>/dev/null || true
  echo "wrote $BASELINE_FILE ($(($(wc -l < "$BASELINE_FILE") - 1)) entries)"
  exit 0
fi

echo
if [ -n "$FAILED" ]; then
  echo "architecture guard FAILED:$FAILED"
  exit 1
fi
echo "All architectural boundaries and code smell checks PASSED!"
