# BaseCamp router agent (GL.iNet)

Sends a GL.iNet router's status to BaseCamp every 5 minutes: WAN and LAN
IPs, uptime, WiFi networks, DHCP clients, connected-client counts, and
VPN tunnels. Tested against GL-AC2100 (firmware 3.x) and GL-MT3000
(firmware 4.x) layouts. Send-only: the router never takes commands from
BaseCamp.

## Install

SSH into the router as `root` (same password as its admin page) and run:

    curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>

The router registers with its WAN MAC address and shows up in the portal
under **Scanning Hardware › Routers** as **Pending**. Everyone who manages
scanning hardware gets an approval notification. Nothing the router sends
is stored until someone approves it; approval lasts until it's revoked.

Options: `--interval SECONDS` (60 or more, default 300), `--ref BRANCH`
(install from a branch or tag instead of `main`).

## Identity

On install the router generates a random secret (`/etc/basecamp/secret`)
and sends it with every report. Approval pins that MAC + secret pair, so
another device can't report as this router just by copying its MAC.
Re-running the installer keeps the secret; so do firmware upgrades (the
installer adds the agent, its secret and its boot link to
`/etc/sysupgrade.conf`). A factory reset
creates a new secret: the router shows as **Pending** with a "Secret
changed" badge and needs approving again.

## Troubleshooting

    basecamp-router once       # send a report now and show the result
    basecamp-router dry-run    # show what would be sent (secret hidden)
    basecamp-router mac        # the WAN MAC it registers with
    logread -e basecamp        # the service's log

## Uninstall

    curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --uninstall

Add `--keep-secret` to keep the router's identity for a later reinstall.
Revoke or delete the router in the portal as well.

## Development

`router_agent/test/run.sh` runs the agent and installer tests in an
OpenWrt rootfs container (needs Docker). Fixtures under
`test/fixtures/` are canned `uci`/`ubus`/`iwinfo`/`wg` output; replace
them with captures from a real router when formats differ.
