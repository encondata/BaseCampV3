# Sirdar: bare environment name redirects to the portal

Date: 2026-10-08. Branch: `sirdar`.

## Goal

Every environment that is not production answers on its base domain
(`demo.serversherpa.com`) with a **302** to
`https://portal.<base domain><same path and query>`. Production gets nothing.
Existing environments get it too (the `demo` environment on Tower, ESXi,
single host, is the live-verify target).

302, not 301: browsers cache a 301 forever, and environment names get reused.

## Model: a `home` hostname row

- New pseudo-service key `home`, stored like the others in
  `environment_services` with `hostname = env.base_domain`, `host_ip`/`port`
  copied from the environment's `portal` row, `proxied = false`.
- `home` is **not** added to `envfile.SERVICES` (it has no container, port
  allocation or `.env` line). One constant `deploy/home.py`
  (`HOME = "home"`) plus helpers:
  - `wants_home(env) -> bool`: `env.type != "production"`.
  - `home_hostname(env) -> str`: `env.base_domain`.
  - `redirect_target(env) -> str`: `f"https://portal.{env.base_domain}"`.
- Ordering: `services_of` sorts `home` right after `portal` (unknown keys
  must not crash the sort).
- Rows are written by `environments._insert` for every non-production
  create (LAN/SSH/VM, adopt, DO) and kept in step with the portal row:
  base-domain PATCH rebuilds its hostname; anything that rewrites the
  portal row's `host_ip`/`port` (LAN Blue/Green `lan_switch` `_point`,
  shared-host port moves) rewrites `home` too.
- Migration `0014_home_redirect`: inserts a `home` row for every
  non-production environment that has a portal row and no `home` row
  (hostname = base_domain, host_ip/port from portal). Downgrade deletes
  `home` rows. No schema change (`managed_records` already keys on
  `(environment_id, service, kind)`; `home` is just another service).

Because DNS, proxy, smoke, Publish tab, Infrastructure tree and the
dashboard certificate pill all read `environment_services.hostname`, the
name shows up everywhere with no further UI work.

## DNS (all targets)

Unchanged code path: step 12 plans `home` like any service, creates the A
record (router public IP on LAN/SSH/VM, LB IP on DO) with comment
`Managed by Sirdar (<env>/home)`, claims an unowned one, and refuses on
the existing conflict rules. Teardown (step 17) removes it the same way.

## NPM targets (LAN, SSH, Proxmox, ESXi, LAN Blue/Green)

The `home` proxy host is a normal Sirdar proxy host (same create/update,
ownership, Let's Encrypt HTTP-01 certificate, `ssl_forced`, teardown),
forwarding to the portal's `host_ip:port`, with `advanced_config`:

```nginx
if ($request_uri !~ "^/\.well-known/acme-challenge/") {
    return 302 https://portal.<base domain>$request_uri;
}
```

The ACME exemption keeps NPM's own certificate renewals working (a bare
server-level `return` would run before NPM's challenge location).
`new_host_body` picks the advanced config per service (`spaces` keeps its
body-size line). Drift check: an existing `home` host whose
`advanced_config` differs from the expected redirect is updated, so a
base-domain change re-points it.

LAN Blue/Green: `home` follows `portal` through `lan_switch` like the
other app services (repoint, record, put back).

## DigitalOcean targets

- One helper `certs.public_names(env)` returns the service names plus
  `env.base_domain` when `wants_home(env)`; `do_provision.prepare`
  (`ctx.hosts`/`ctx.names`), `do_envs.env_extra` (`SS_CERT_NAMES`) and
  every exact-SAN comparison use it, so the three lists cannot drift.
- `_certificate`: a recorded certificate whose `dns_names` lack a wanted
  name is due (reissued now), not kept until 14 days before expiry. This
  is how existing DO environments pick the name up on their next deploy
  or renewal.
- `deploy/stack/proxy/Caddyfile`: new matcher
  `@home host {$STACK_DOMAIN}` with
  `redir @home https://portal.{$STACK_DOMAIN}{uri} 302`, placed after the
  ACME-challenge and LB-health handlers. Production stacks get the rule
  too but no DNS record or SAN, so it is never reached.

## Smoke

`home` smoke expects exactly a 302 whose `Location` starts with
`https://portal.<base domain>/` (stricter than the generic 2xx/3xx pass,
so a misconfigured host that serves the portal directly fails).

## Out of scope

- No new UI. No toggle (every non-production environment gets it).
- No redirect for the other services' bare paths, no apex domain.

## Testing

- Unit: `home` rows on create per type (none for production), PATCH
  rebuild, migration upgrade/downgrade on a seeded DB, `services_of`
  order, NPM body/advanced config + drift update, `lan_switch` moves
  `home` with `portal`, DO `public_names` used by all three callers,
  missing-SAN reissue, smoke Location rule, Caddyfile contains the
  matcher.
- Live: deploy the branch to Tower, publish `demo`; `dig
  demo.serversherpa.com`, `curl -sI https://demo.serversherpa.com/x?y=1`
  returns 302 to `https://portal.demo.serversherpa.com/x?y=1` with a
  valid certificate; dashboard shows the pill.
