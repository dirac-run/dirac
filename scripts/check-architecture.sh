#!/bin/bash
# check-architecture.sh — mechanical architecture guard (TECH-DEBT-PLAN item 0).
# Step 1 runs dependency-cruiser and judges the module graph (boundaries,
# cycles, shims) via scripts/check-arch-graph.mjs — new cyclic-SCC members and
# baseline SCC merges are hard failures.
# Step 2 runs targeted syntax checks for code-level smells (|| 0, env scatter,
# any ratchet) against the frozen baseline in scripts/architecture-baseline.txt.
#
# Usage: check-architecture.sh [--write-baseline] [--only <check_id>]
set -uo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE="scripts/architecture-baseline.txt"
ALLOWLIST_FILE="scripts/architecture-allowlist.txt"
WRITE_BASELINE=0
ONLY_CHECK=""
ALL_SYNTAX_CHECKS="check_one_tool_taxonomy check_no_numeric_or_default check_env_centralized check_any_ratchet"

while [ $# -gt 0 ]; do
  case "$1" in
    --write-baseline) WRITE_BASELINE=1 ;;
    --only)
      shift
      ONLY_CHECK="${1:-}"
      [ -n "$ONLY_CHECK" ] || { echo "ERROR: --only requires a check_id" >&2; exit 2; }
      case " $ALL_SYNTAX_CHECKS " in
        *" $ONLY_CHECK "*) ;;
        *) echo "ERROR: unknown check_id '$ONLY_CHECK' (known: $ALL_SYNTAX_CHECKS)" >&2; exit 2 ;;
      esac
      ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT

if [ -z "$ONLY_CHECK" ]; then
  echo "===> Step 1: Module graph (boundaries + SCC partition)..."
  # depcruise exits non-zero whenever violations exist; the report is judged by
  # check-arch-graph.mjs against the baselines instead, so the code is ignored.
  npx depcruise src cli/src webview-ui/src --config .dependency-cruiser.js --output-type json > "$TMPD/graph.json" || true
  [ -s "$TMPD/graph.json" ] || { echo "ERROR: dependency-cruiser produced no report" >&2; exit 2; }
  if [ "$WRITE_BASELINE" = 1 ]; then
    node scripts/check-arch-graph.mjs "$TMPD/graph.json" --write-baseline || exit $?
  else
    node scripts/check-arch-graph.mjs "$TMPD/graph.json" || exit $?
  fi
  echo
  echo "===> Step 2: Running code-level syntax & smell checks..."
else
  echo "===> --only $ONLY_CHECK (Step 1 skipped)"
fi

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
  # line-level check: which core lines read process.env directly (plan item 8);
  # the driver's normalisation strips line numbers, so entries survive line shifts
  grep -rEn 'process\.env' "${EXCLUDES[@]}" --include='*.ts' src/core/ 2>/dev/null | grep -v '__tests__\|\.test\.ts'
}

check_any_ratchet() {
  # diff-based, zero-tolerance: new `as any` / `: any` added in src code fails
  local base
  base=$(git merge-base HEAD origin/master 2>/dev/null || git merge-base HEAD master 2>/dev/null || true)
  if [ -z "$base" ]; then
    echo "ERROR: check_any_ratchet requires a merge base with origin/master. In CI, set fetch-depth: 0." >&2
    return 2
  fi
  git diff -U0 "$base" -- src cli/src webview-ui/src 2>/dev/null | \
    awk '/^\+\+\+ b\// { file = substr($0, 7); next }
         /^\+/ && ($0 ~ /as any([^A-Za-z0-9_]|$)/ || $0 ~ /: *any([^A-Za-z0-9_(]|$)/) {
           if (file !~ /\.test\.|__tests__/) print file ":" substr($0, 2)
         }'
}

SYNTAX_CHECKS="$ALL_SYNTAX_CHECKS"
[ -n "$ONLY_CHECK" ] && SYNTAX_CHECKS="$ONLY_CHECK"
FAILED=""

for id in $SYNTAX_CHECKS; do
  status=0
  "$id" > "$TMPD/raw" 2>&1 || status=$?
  if [ "$status" -eq 2 ]; then
    echo "ERROR: Critical failure in $id (missing merge base):" >&2
    cat "$TMPD/raw" >&2
    exit 2
  fi
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
  # --only regenerates just that check's entries; keep the other checks as they were
  [ -n "$ONLY_CHECK" ] && [ -f "$BASELINE_FILE" ] && \
    grep -v "^$ONLY_CHECK	" "$BASELINE_FILE" | tail -n +2 >> "$TMPD/newbaseline" || true
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
