#!/bin/sh
# install.sh in a real OpenWrt rootfs: files, UCI config, secret, sysupgrade
# keep-list, rc.d link; re-install keeps the secret; uninstall cleans up.
FAIL=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
mkdir -p /tmp/lock /tmp/run
touch /etc/sysupgrade.conf
# the rootfs image ships no system section; a router always has one
printf "config system\n\toption hostname 'OpenWrt'\n" > /etc/config/system
hostname_is() { [ "$(uci -q get system.@system[0].hostname)" = "$1" ]; }
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
check "sysupgrade keeps the boot link" 'grep -qxF /etc/rc.d/S99basecamp-router /etc/sysupgrade.conf'
check "tells the user it is waiting on the portal" 'grep -q "Scanning Hardware" /tmp/out'
check "first line says the installer started" '[ "$(head -n 1 /tmp/out)" = "basecamp: installer starting" ]'
check "a fresh secret isn't reported as damaged" '! grep -q damaged /tmp/out'
first=$(cat /etc/basecamp/secret)
check "never prints the secret" '[ -n "$first" ] && ! grep -qF "$first" /tmp/out'
check "no terminal and no --hostname keeps the hostname" 'hostname_is OpenWrt'
check "says the hostname was kept" 'grep -qxF "basecamp: no terminal; kept the hostname OpenWrt (use --hostname to set one)" /tmp/out'

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
check "full uninstall drops the boot link from the keep-list" '! grep -qF S99basecamp-router /etc/sysupgrade.conf'

# --hostname sets the router's name before the first report
$INSTALL --api https://api.example.test --hostname dock-router-7 >/tmp/out 2>&1
rc=$?
check "--hostname installs" '[ $rc -eq 0 ]'
check "--hostname sets the hostname" 'hostname_is dock-router-7'
check "says the hostname was set" 'grep -qxF "basecamp: hostname set to dock-router-7" /tmp/out'
check "hostname is set before the first report" '[ "$(grep -n "hostname set to" /tmp/out | cut -d: -f1)" -lt "$(grep -n "sending a first report" /tmp/out | cut -d: -f1)" ]'
check "--hostname never prints the secret" '! grep -qF "$(cat /etc/basecamp/secret)" /tmp/out'
$INSTALL --uninstall >/tmp/out 2>&1
check "uninstall leaves the hostname alone" 'hostname_is dock-router-7'
$INSTALL --api https://api.example.test --hostname -bad- >/tmp/out 2>&1
rc=$?
check "an invalid --hostname fails" '[ $rc -ne 0 ]'
check "an invalid --hostname installs nothing" '[ ! -e /usr/bin/basecamp-router ] && [ ! -e /etc/config/basecamp ] && [ ! -e /etc/basecamp ]'
check "an invalid --hostname leaves the hostname" 'hostname_is dock-router-7'
$INSTALL --api https://api.example.test --hostname aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/tmp/out 2>&1
check "a 64-character --hostname fails" '[ $? -ne 0 ] && [ ! -e /usr/bin/basecamp-router ]'
uci set system.@system[0].hostname=OpenWrt && uci commit system

# the prompt: BASECAMP_TTY stands in for /dev/tty, a file holding the
# answers (the installer appends its prompts to the same file)
prompt_install() {  # answers...
  printf '%s\n' "$@" > /tmp/tty
  BASECAMP_TTY=/tmp/tty $INSTALL --api https://api.example.test >/tmp/out 2>&1
}
prompt_install dock-router-8
rc=$?
check "prompt: installs" '[ $rc -eq 0 ]'
check "prompt: shows the current hostname" 'grep -qF "basecamp: router hostname [OpenWrt]: " /tmp/tty'
check "prompt: a valid answer sets the hostname" 'hostname_is dock-router-8'
check "prompt: says the hostname was set" 'grep -qxF "basecamp: hostname set to dock-router-8" /tmp/out'
check "prompt: never prints the secret" '! grep -qF "$(cat /etc/basecamp/secret)" /tmp/out /tmp/tty'
prompt_install ""
check "prompt: an empty answer keeps the hostname" 'hostname_is dock-router-8'
check "prompt: says it kept the hostname" 'grep -qF "kept the hostname dock-router-8" /tmp/out /tmp/tty'
prompt_install -bad- dock-router-9
check "prompt: an invalid answer then a valid one sets the valid one" 'hostname_is dock-router-9'
check "prompt: explains the invalid answer" 'grep -q "can.t start or end with a hyphen" /tmp/tty'
check "prompt: asks again after an invalid answer" '[ "$(grep -o "router hostname \[" /tmp/tty | wc -l)" -eq 2 ]'
prompt_install bad_name "" "" ""
check "prompt: an empty answer after an invalid one keeps the hostname" 'hostname_is dock-router-9'
prompt_install bad_1 bad_2 bad_3 dock-router-10
check "prompt: three invalid answers keep the hostname" 'hostname_is dock-router-9'
check "prompt: asks only three times" '[ "$(grep -o "router hostname \[" /tmp/tty | wc -l)" -eq 3 ]'
check "prompt: says it gave up and kept the hostname" 'grep -qF "kept the hostname dock-router-9" /tmp/out /tmp/tty'
: > /tmp/tty
BASECAMP_TTY=/tmp/tty $INSTALL --api https://api.example.test --hostname dock-router-11 >/tmp/out 2>&1
check "prompt: --hostname skips the prompt" 'hostname_is dock-router-11 && [ ! -s /tmp/tty ]'
printf 'dock-router-12\n' > /tmp/tty
BASECAMP_TTY=/tmp/tty $INSTALL --uninstall >/tmp/out 2>&1
check "prompt: never asked on --uninstall" 'hostname_is dock-router-11 && [ "$(cat /tmp/tty)" = dock-router-12 ]'
uci set system.@system[0].hostname=OpenWrt && uci commit system

# a BusyBox built without hexdump: the sha256sum fallback still makes a secret
mkdir -p /tmp/nohex && printf '#!/bin/sh\nexit 1\n' > /tmp/nohex/hexdump && chmod +x /tmp/nohex/hexdump
PATH="/tmp/nohex:$PATH" $INSTALL --api https://api.example.test >/tmp/out 2>&1
check "makes a secret without hexdump" 'grep -qE "^[0-9a-f]{64}$" /etc/basecamp/secret'
check "the fallback secret is new" '[ "$(cat /etc/basecamp/secret)" != "$first" ]'
$INSTALL --uninstall >/tmp/out 2>&1

# a damaged secret is replaced, and the user is told the router needs approving again
mkdir -p /etc/basecamp && echo not-a-secret > /etc/basecamp/secret
$INSTALL --api https://api.example.test >/tmp/out 2>&1
check "replaces a damaged secret" 'grep -qE "^[0-9a-f]{64}$" /etc/basecamp/secret'
check "says the damaged secret was replaced" 'grep -qxF "basecamp: the existing secret was damaged; generated a new one — this router will need approving again" /tmp/out'
$INSTALL --uninstall >/tmp/out 2>&1

# no `id` command: the root check falls back instead of "id: not found"
mkdir -p /tmp/noid
for d in /bin /sbin /usr/bin /usr/sbin; do
  for f in "$d"/*; do [ "${f##*/}" = id ] || ln -sf "$f" "/tmp/noid/${f##*/}"; done
done
PATH="/src/test/install-stubs:/tmp/noid" $INSTALL --api https://api.example.test >/tmp/out 2>&1
rc=$?
check "installs as root without an id command" '[ $rc -eq 0 ] && [ -x /usr/bin/basecamp-router ]'
check "no 'not found' noise without id" '! grep -q "not found" /tmp/out'
$INSTALL --uninstall >/tmp/out 2>&1

# a keep list saved without a trailing newline (LuCI does this)
printf '/etc/userline\n/etc/mykeep' > /etc/sysupgrade.conf
$INSTALL --api https://api.example.test >/tmp/out 2>&1
for f in /etc/userline /etc/mykeep /etc/basecamp/ /etc/config/basecamp /usr/bin/basecamp-router /etc/init.d/basecamp-router; do
  check "no-newline keep list has $f on its own line" 'grep -qxF "$f" /etc/sysupgrade.conf'
done
$INSTALL --uninstall >/tmp/out 2>&1
check "uninstall leaves exactly the user's keep lines" '[ "$(cat /etc/sysupgrade.conf)" = "$(printf "/etc/userline\n/etc/mykeep")" ]'

# piped like the README's `curl ... | sh -s --`, from a clean state
$INSTALL --uninstall >/dev/null 2>&1
cat /src/install.sh | sh -s -- --source $SRC --api https://api.example.test >/tmp/out 2>&1
rc=$?
check "piped install succeeds" '[ $rc -eq 0 ] && [ -x /usr/bin/basecamp-router ] && grep -q "installer starting" /tmp/out'
$INSTALL --uninstall >/dev/null 2>&1
size=$(wc -c < /src/install.sh)
head -c $((size * 6 / 10)) /src/install.sh | sh -s -- --source $SRC --api https://api.example.test >/tmp/out 2>&1
rc=$?
check "a truncated piped script installs nothing" '[ ! -e /usr/bin/basecamp-router ] && [ ! -e /etc/init.d/basecamp-router ] && [ ! -e /etc/basecamp ]'
check "a truncated piped script doesn't exit 0" '[ $rc -ne 0 ]'
check "a truncated piped script never says it started" '! grep -q "installer starting" /tmp/out'

[ "$FAIL" = 0 ] && echo "ALL INSTALL TESTS PASSED"
exit $FAIL
