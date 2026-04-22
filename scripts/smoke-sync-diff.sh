#!/usr/bin/env bash
# Desktop <-> Harmony phone sync smoke diff.
#
# Modes:
#   scripts/smoke-sync-diff.sh                    # quick snapshot (counts + tails)
#   scripts/smoke-sync-diff.sh --save-baseline    # freeze current max HLC per table
#   scripts/smoke-sync-diff.sh --delta "A pre"    # rows written since baseline
#   scripts/smoke-sync-diff.sh --clear-baseline   # drop baseline file
#
# The delta mode is what we use during scenario smoke tests — it filters out
# historical drift (old device_ids, soft-deleted tombstones from months ago)
# and only shows rows freshly written during the current test session.
#
# Baseline is a tiny flat file in /tmp; no mutations anywhere.

set -euo pipefail

MODE="snapshot"
LABEL=""
TAIL=10
while [[ $# -gt 0 ]]; do
  case "$1" in
    --save-baseline)   MODE="save-baseline"; shift ;;
    --clear-baseline)  MODE="clear-baseline"; shift ;;
    --delta)           MODE="delta"; LABEL="${2:-delta}"; shift 2 ;;
    --label)           LABEL="$2"; shift 2 ;;
    --tail)            TAIL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REMOTE=inming@192.168.64.1
HDC="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc"
MOBILE_DB_REMOTE="/data/app/el2/100/base/com.shibei.harmony.phase0/haps/entry/files/shibei.db"
MOBILE_DB_LOCAL="/tmp/shibei-mobile.db"
DESKTOP_DB="$HOME/Library/Application Support/shibei/shibei.db"
BASELINE="/tmp/shibei-smoke-baseline.tsv"

if [[ "$MODE" == "clear-baseline" ]]; then
  rm -f "$BASELINE"
  echo "baseline cleared ($BASELINE)"
  exit 0
fi

[[ -f "$DESKTOP_DB" ]] || { echo "desktop DB not found: $DESKTOP_DB" >&2; exit 1; }

pull_mobile() {
  ssh -o ConnectTimeout=5 "$REMOTE" "$HDC file recv $MOBILE_DB_REMOTE $MOBILE_DB_LOCAL >/dev/null 2>&1" \
    || { echo "hdc pull failed (phone awake?)" >&2; exit 1; }
  scp -q "$REMOTE:$MOBILE_DB_LOCAL" "$MOBILE_DB_LOCAL" \
    || { echo "scp pull failed" >&2; exit 1; }
}

q() { sqlite3 "$1" "$2" 2>/dev/null || echo ""; }

TABLES=(resources folders highlights comments tags)

max_hlc() {  # db, table
  q "$1" "SELECT COALESCE(MAX(hlc),'') FROM $2"
}
max_log_id() {
  q "$1" "SELECT COALESCE(MAX(id),0) FROM sync_log"
}

counts() {  # db, table → "active/total"
  local db="$1" t="$2"
  local a; a=$(q "$db" "SELECT COUNT(*) FROM $t WHERE deleted_at IS NULL")
  local tot; tot=$(q "$db" "SELECT COUNT(*) FROM $t")
  echo "${a}/${tot}"
}

pull_mobile

### MODE: save-baseline ----------------------------------------------------
if [[ "$MODE" == "save-baseline" ]]; then
  : > "$BASELINE"
  {
    echo "# side<tab>table<tab>max_hlc<tab>active<tab>total"
    for side in desktop mobile; do
      db=$([[ "$side" == desktop ]] && echo "$DESKTOP_DB" || echo "$MOBILE_DB_LOCAL")
      for t in "${TABLES[@]}"; do
        hlc=$(max_hlc "$db" "$t")
        c=$(counts "$db" "$t")
        active=${c%/*}; total=${c#*/}
        printf '%s\t%s\t%s\t%s\t%s\n' "$side" "$t" "$hlc" "$active" "$total"
      done
      hlc_log=$(q "$db" "SELECT COALESCE(MAX(hlc),'') FROM sync_log")
      log_id=$(max_log_id "$db")
      printf '%s\t%s\t%s\t%s\t%s\n' "$side" "sync_log" "$hlc_log" "$log_id" "$log_id"
    done
  } > "$BASELINE"
  echo "baseline saved → $BASELINE"
  column -t -s "$(printf '\t')" "$BASELINE"
  exit 0
fi

get_baseline() {  # side, table → max_hlc
  awk -F'\t' -v s="$1" -v t="$2" '$1==s && $2==t {print $3}' "$BASELINE"
}

### MODE: delta ------------------------------------------------------------
if [[ "$MODE" == "delta" ]]; then
  [[ -f "$BASELINE" ]] || { echo "no baseline yet — run with --save-baseline first" >&2; exit 1; }
  printf '\n=== DELTA %s ===\n' "$LABEL"
  printf '%-12s %-8s %-8s  %s\n' "table" "desktop+" "mobile+" "(rows with hlc > baseline)"
  echo "────────────────────────────────────────────────────────"
  for t in "${TABLES[@]}"; do
    dbl=$(get_baseline desktop "$t"); mbl=$(get_baseline mobile "$t")
    d=$(q "$DESKTOP_DB" "SELECT COUNT(*) FROM $t WHERE hlc > '$dbl'")
    m=$(q "$MOBILE_DB_LOCAL" "SELECT COUNT(*) FROM $t WHERE hlc > '$mbl'")
    printf '%-12s %-8s %-8s\n' "$t" "$d" "$m"
  done
  dbl=$(get_baseline desktop sync_log); mbl=$(get_baseline mobile sync_log)
  d=$(q "$DESKTOP_DB" "SELECT COUNT(*) FROM sync_log WHERE hlc > '$dbl'")
  m=$(q "$MOBILE_DB_LOCAL" "SELECT COUNT(*) FROM sync_log WHERE hlc > '$mbl'")
  printf '%-12s %-8s %-8s\n' "sync_log" "$d" "$m"

  echo
  echo "─── new sync_log entries on DESKTOP ───"
  sqlite3 -header -column "$DESKTOP_DB" \
    "SELECT operation AS op, entity_type, substr(entity_id,1,12) AS id, substr(hlc,1,13) AS hlc_t, uploaded
       FROM sync_log WHERE hlc > '$dbl' ORDER BY hlc"
  echo
  echo "─── new sync_log entries on MOBILE ───"
  sqlite3 -header -column "$MOBILE_DB_LOCAL" \
    "SELECT operation AS op, entity_type, substr(entity_id,1,12) AS id, substr(hlc,1,13) AS hlc_t, uploaded
       FROM sync_log WHERE hlc > '$mbl' ORDER BY hlc"

  echo
  for t in highlights comments resources folders; do
    dbl=$(get_baseline desktop "$t"); mbl=$(get_baseline mobile "$t")
    echo "─── new $t rows (hlc > baseline) ───"
    sqlite3 -header -column "$DESKTOP_DB" \
      "SELECT 'desktop' AS side, substr(id,1,12) AS id, substr(hlc,1,13) AS hlc_t, deleted_at IS NOT NULL AS del
         FROM $t WHERE hlc > '$dbl' ORDER BY hlc"
    sqlite3 -header -column "$MOBILE_DB_LOCAL" \
      "SELECT 'mobile'  AS side, substr(id,1,12) AS id, substr(hlc,1,13) AS hlc_t, deleted_at IS NOT NULL AS del
         FROM $t WHERE hlc > '$mbl' ORDER BY hlc"
    echo
  done
  exit 0
fi

### MODE: snapshot (default) -----------------------------------------------
if [[ -n "$LABEL" ]]; then printf '\n=== %s ===\n' "$LABEL"; fi

printf '\n%-14s %-40s %-40s %s\n' "" "DESKTOP" "MOBILE" "diff"
printf '%s\n' "──────────────────────────────────────────────────────────────────────────────────────────────────────"
device_desktop=$(q "$DESKTOP_DB" "SELECT device_id FROM sync_log ORDER BY id DESC LIMIT 1")
device_mobile=$(q "$MOBILE_DB_LOCAL" "SELECT device_id FROM sync_log ORDER BY id DESC LIMIT 1")
printf '%-14s %-40s %-40s\n' "device_id" "$device_desktop" "$device_mobile"

for t in "${TABLES[@]}"; do
  D=$(counts "$DESKTOP_DB" "$t"); M=$(counts "$MOBILE_DB_LOCAL" "$t")
  diff=""; [[ "$D" != "$M" ]] && diff="≠"
  printf '%-14s %-40s %-40s %s\n' "$t" "$D" "$M" "$diff"
done
D=$(q "$DESKTOP_DB" "SELECT COUNT(*) FROM sync_log"); M=$(q "$MOBILE_DB_LOCAL" "SELECT COUNT(*) FROM sync_log")
diff=""; [[ "$D" != "$M" ]] && diff="≠"
printf '%-14s %-40s %-40s %s\n' "sync_log" "$D" "$M" "$diff"
D=$(q "$DESKTOP_DB" "SELECT COALESCE(MAX(hlc),'') FROM sync_log")
M=$(q "$MOBILE_DB_LOCAL" "SELECT COALESCE(MAX(hlc),'') FROM sync_log")
if   [[ "$D" > "$M" ]]; then ahead="desktop ahead"
elif [[ "$M" > "$D" ]]; then ahead="mobile ahead"
else ahead="equal"; fi
printf '%-14s %-40s %-40s %s\n' "max_hlc" "${D:0:13}" "${M:0:13}" "$ahead"

echo
echo "─── desktop sync_log (last $TAIL) ───"
sqlite3 -header -column "$DESKTOP_DB" \
  "SELECT operation AS op, entity_type, substr(entity_id,1,12) AS id, substr(hlc,1,13) AS hlc_t, uploaded
     FROM sync_log ORDER BY hlc DESC LIMIT $TAIL"
echo
echo "─── mobile sync_log (last $TAIL) ───"
sqlite3 -header -column "$MOBILE_DB_LOCAL" \
  "SELECT operation AS op, entity_type, substr(entity_id,1,12) AS id, substr(hlc,1,13) AS hlc_t, uploaded
     FROM sync_log ORDER BY hlc DESC LIMIT $TAIL"

echo
if [[ -f "$BASELINE" ]]; then
  echo "(baseline exists — run with --delta LABEL to see session-only writes)"
else
  echo "(no baseline — run --save-baseline to freeze current state for scenario diffs)"
fi
