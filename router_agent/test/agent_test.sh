#!/bin/sh
# Agent fixture tests: run `basecamp-router dry-run` against each fixture
# router and check the JSON with jsonfilter. expect.tsv lines are
# <expression><TAB><expected value>, where the expression is
#   @.path          the value jsonfilter prints (a JSON null prints nothing)
#   type:@.path     the JSON type (null, string, array, ...; "" if absent)
#   !...            either form, negated: the result must NOT equal the value
# Then: lifecycle checks (missing secret, mac, interval parsing, TERM, temp dir).
FAIL=0
TAB=$(printf '\t')
AGENT=/src/basecamp-router.sh
STUBS=/src/test/stubs
mkdir -p /tmp/lock /tmp/run

ok() { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAIL=1; }
agent() {  # fixture-dir root-dir args...
  f=$1; r=$2; shift 2
  FIXTURE="$f" BASECAMP_ROOT="$r" PATH="$STUBS:$PATH" sh "$AGENT" "$@"
}

# A cwd with a file a stray glob of "@wifi-iface[0]" would match.
mkdir -p /tmp/globtrap && : > '/tmp/globtrap/@wifi-iface0'
cd /tmp/globtrap

for F in /src/test/fixtures/*/; do
  F=${F%/}; fx=${F##*/}
  OUT=$(agent "$F" "$F/root" dry-run 2>/tmp/err)
  if [ $? -ne 0 ]; then fail "$fx: dry-run exited non-zero: $(cat /tmp/err)"; continue; fi
  echo "$OUT" | jsonfilter -e '@' >/dev/null 2>&1 || { fail "$fx: not JSON: $OUT"; continue; }
  while IFS="$TAB" read -r expr want; do
    [ -n "$expr" ] || continue
    neg=0; e=$expr
    case "$e" in '!'*) neg=1; e=${e#!} ;; esac
    case "$e" in
      type:*) got=$(echo "$OUT" | jsonfilter -t "${e#type:}" 2>/dev/null) ;;
      *) got=$(echo "$OUT" | jsonfilter -e "$e" 2>/dev/null) ;;
    esac
    if [ "$neg" = 0 ] && [ "$got" = "$want" ]; then ok "$fx $expr"
    elif [ "$neg" = 1 ] && [ "$got" != "$want" ]; then ok "$fx $expr"
    elif [ "$neg" = 1 ]; then fail "$fx $expr: want not [$want] got [$got]"
    else fail "$fx $expr: want [$want] got [$got]"; fi
  done < "$F/expect.tsv"

  # mac: exits 0 and prints the WAN MAC
  if agent "$F" "$F/root" mac > /tmp/mac; then ok "$fx mac exits 0"; else fail "$fx mac exited non-zero"; fi
  want_mac=$(awk -F"$TAB" '$1 == "@.wan_mac" { print $2 }' "$F/expect.tsv")
  [ -z "$want_mac" ] || { [ "$(cat /tmp/mac)" = "$want_mac" ] && ok "$fx mac" || fail "$fx mac: got [$(cat /tmp/mac)]"; }

  # dry-run fails without the secret file
  rm -rf /tmp/nosecret && cp -r "$F/root" /tmp/nosecret && rm -f /tmp/nosecret/etc/basecamp/secret
  if agent "$F" /tmp/nosecret dry-run >/dev/null 2>&1; then fail "$fx dry-run without secret exited 0"
  else ok "$fx dry-run without secret exits non-zero"; fi
done

# --- interval parsing (the agent sourced as a library)
FW4=/src/test/fixtures/fw4-mt3000
rm -rf /tmp/ivfx && mkdir -p /tmp/ivfx && cp -r "$FW4/config" /tmp/ivfx/
for pair in 090:90 0300:300 600:600 30:60 000:60 abc:300 empty:300; do
  v=${pair%%:*}; want=${pair#*:}
  if [ "$v" = empty ]; then uci -c /tmp/ivfx/config -q delete basecamp.agent.interval
  else uci -c /tmp/ivfx/config set basecamp.agent.interval="$v"; fi
  uci -c /tmp/ivfx/config commit basecamp
  got=$(FIXTURE=/tmp/ivfx BASECAMP_ROOT="$FW4/root" BASECAMP_LIB=1 PATH="$STUBS:$PATH" \
        sh -c ". $AGENT && interval_seconds" 2>&1)
  [ "$got" = "$want" ] && ok "interval '$v' -> $want" || fail "interval '$v': want [$want] got [$got]"
done

# --- private temp dir; TERM stops `run` at once and cleans up
for d in /tmp/bctmp/*; do [ -e "$d" ] && rm -rf "$d"; done; mkdir -p /tmp/bctmp
OUT=$(TMPDIR=/tmp/bctmp agent "$FW4" "$FW4/root" dry-run 2>&1)
[ -z "$(ls -A /tmp/bctmp)" ] && ok "dry-run leaves no temp files" || fail "dry-run left temp files: $(ls -A /tmp/bctmp)"
TMPDIR=/tmp/bctmp FIXTURE="$FW4" BASECAMP_ROOT="$FW4/root" PATH="$STUBS:$PATH" sh "$AGENT" run &
P=$!
sleep 1
n=0; for d in /tmp/bctmp/basecamp.*; do [ -d "$d" ] && n=$((n + 1)); done
mode=$(ls -ld /tmp/bctmp/basecamp.* 2>/dev/null | awk '{ print $1; exit }')
[ "$n" = 1 ] && [ "$mode" = drwx------ ] && ok "run uses one private temp dir" \
  || fail "run temp dir: want 1 drwx------ dir, got $n [$mode]: $(ls -lA /tmp/bctmp)"
kill -TERM "$P"
t=0; while kill -0 "$P" 2>/dev/null && [ $t -lt 3 ]; do sleep 1; t=$((t + 1)); done
if kill -0 "$P" 2>/dev/null; then fail "run still alive ${t}s after TERM"; kill -KILL "$P" 2>/dev/null
else ok "run exits promptly on TERM"; fi
wait "$P" 2>/dev/null
if ps | grep -v grep | grep -q 'sleep [0-9][0-9]'; then fail "run left its sleep behind"; kill $(pgrep sleep) 2>/dev/null
else ok "run leaves no sleep behind"; fi
[ -z "$(ls -A /tmp/bctmp)" ] && ok "run cleans its temp dir on TERM" || fail "run left $(ls -A /tmp/bctmp)"

[ "$FAIL" = 0 ] && echo "ALL AGENT TESTS PASSED"
exit $FAIL
