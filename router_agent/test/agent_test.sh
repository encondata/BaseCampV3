#!/bin/sh
# Agent fixture tests: run `basecamp-router dry-run` against each fixture
# router and check the JSON with jsonfilter. expect.tsv lines are
# <jsonfilter expression><TAB><expected value>.
FAIL=0
TAB=$(printf '\t')
mkdir -p /tmp/lock /tmp/run
for F in /src/test/fixtures/*/; do
  F=${F%/}; fx=${F##*/}
  OUT=$(FIXTURE="$F" BASECAMP_ROOT="$F/root" PATH="/src/test/stubs:$PATH" \
        sh /src/basecamp-router.sh dry-run 2>/tmp/err)
  if [ $? -ne 0 ]; then echo "FAIL $fx: dry-run exited non-zero: $(cat /tmp/err)"; FAIL=1; continue; fi
  echo "$OUT" | jsonfilter -e '@' >/dev/null 2>&1 || { echo "FAIL $fx: not JSON: $OUT"; FAIL=1; continue; }
  while IFS="$TAB" read -r expr want; do
    [ -n "$expr" ] || continue
    got=$(echo "$OUT" | jsonfilter -e "$expr" 2>/dev/null)
    if [ "$got" = "$want" ]; then echo "ok   $fx $expr"
    else echo "FAIL $fx $expr: want [$want] got [$got]"; FAIL=1; fi
  done < "$F/expect.tsv"
  FIXTURE="$F" BASECAMP_ROOT="$F/root" PATH="/src/test/stubs:$PATH" sh /src/basecamp-router.sh mac > /tmp/mac
  want_mac=$(awk -F"$TAB" '$1 == "@.wan_mac" { print $2 }' "$F/expect.tsv")
  [ "$(cat /tmp/mac)" = "$want_mac" ] && echo "ok   $fx mac" || { echo "FAIL $fx mac"; FAIL=1; }
done
[ "$FAIL" = 0 ] && echo "ALL AGENT TESTS PASSED"
exit $FAIL
