#!/bin/sh
# install.sh in a real OpenWrt rootfs: files, UCI config, secret, sysupgrade
# keep-list, rc.d link; re-install keeps the secret; uninstall cleans up.
FAIL=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
mkdir -p /tmp/lock /tmp/run
touch /etc/sysupgrade.conf
export PATH="/src/test/install-stubs:$PATH"
SRC=file:///src
INSTALL="sh /src/install.sh --source $SRC"

$INSTALL --api http://api.example.test >/tmp/out 2>&1
check "refuses a plain-http API" '[ $? -ne 0 ] && [ ! -e /usr/bin/basecamp-router ]'
$INSTALL >/tmp/out 2>&1
check "requires --api on a first install" '[ $? -ne 0 ]'

$INSTALL --api https://api.example.test/ >/tmp/out 2>&1
rc=$?
check "installs (exit 0 even though the first report can't reach the API)" '[ $rc -eq 0 ]'
check "agent installed and executable" '[ -x /usr/bin/basecamp-router ]'
check "service installed" '[ -x /etc/init.d/basecamp-router ]'
check "service enabled at boot" '[ -e /etc/rc.d/S99basecamp-router ]'
check "service lets a report in flight finish before SIGKILL" 'grep -q "procd_set_param term_timeout 30" /etc/init.d/basecamp-router'
check "api_url saved without trailing slash" '[ "$(uci -q get basecamp.agent.api_url)" = https://api.example.test ]'
check "interval defaults to 300" '[ "$(uci -q get basecamp.agent.interval)" = 300 ]'
check "secret is 64 hex chars" 'grep -qE "^[0-9a-f]{64}$" /etc/basecamp/secret'
check "secret is owner-only" '[ "$(ls -l /etc/basecamp/secret | cut -c1-10)" = "-rw-------" ]'
for f in /etc/basecamp/ /etc/config/basecamp /usr/bin/basecamp-router /etc/init.d/basecamp-router; do
  check "sysupgrade keeps $f" 'grep -qxF "$f" /etc/sysupgrade.conf'
done
check "tells the user it is waiting on the portal" 'grep -q "Scanning Hardware" /tmp/out'
first=$(cat /etc/basecamp/secret)
check "never prints the secret" '[ -n "$first" ] && ! grep -qF "$first" /tmp/out'

$INSTALL --api https://api2.example.test --interval 600 >/tmp/out 2>&1
check "re-install keeps the secret" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
check "re-install updates api_url" '[ "$(uci -q get basecamp.agent.api_url)" = https://api2.example.test ]'
check "re-install sets the interval" '[ "$(uci -q get basecamp.agent.interval)" = 600 ]'
check "no duplicate keep-list lines" '[ "$(grep -cxF /etc/basecamp/ /etc/sysupgrade.conf)" = 1 ]'
$INSTALL --interval 30 >/tmp/out 2>&1
check "refuses an interval under 60s" '[ $? -ne 0 ]'

$INSTALL --uninstall --keep-secret >/tmp/out 2>&1
check "uninstall --keep-secret keeps the secret" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
check "uninstall removes the agent" '[ ! -e /usr/bin/basecamp-router ] && [ ! -e /etc/init.d/basecamp-router ]'
check "uninstall removes the rc.d link" '[ ! -e /etc/rc.d/S99basecamp-router ]'
check "uninstall removes the config" '[ ! -e /etc/config/basecamp ]'

$INSTALL --api https://api.example.test >/tmp/out 2>&1
check "install after --keep-secret reuses it" '[ "$(cat /etc/basecamp/secret)" = "$first" ]'
$INSTALL --uninstall >/tmp/out 2>&1
check "full uninstall removes the secret" '[ ! -e /etc/basecamp ]'
check "full uninstall cleans the keep-list" '! grep -q basecamp /etc/sysupgrade.conf'

# a BusyBox built without hexdump: the sha256sum fallback still makes a secret
mkdir -p /tmp/nohex && printf '#!/bin/sh\nexit 1\n' > /tmp/nohex/hexdump && chmod +x /tmp/nohex/hexdump
PATH="/tmp/nohex:$PATH" $INSTALL --api https://api.example.test >/tmp/out 2>&1
check "makes a secret without hexdump" 'grep -qE "^[0-9a-f]{64}$" /etc/basecamp/secret'
check "the fallback secret is new" '[ "$(cat /etc/basecamp/secret)" != "$first" ]'
$INSTALL --uninstall >/tmp/out 2>&1

[ "$FAIL" = 0 ] && echo "ALL INSTALL TESTS PASSED"
exit $FAIL
