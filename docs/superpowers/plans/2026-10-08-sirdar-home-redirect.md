# Sirdar Home Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every non-production environment answers on its bare base domain (`demo.serversherpa.com`) with a 302 to `https://portal.<base domain><same path and query>`; production gets nothing.

**Architecture:** A pseudo-service row `home` in `environment_services` (hostname = base domain, host/port copied from `portal`) rides the existing DNS, NPM, smoke, Publish tab and dashboard paths. One small module `deploy/home.py` owns the name, the rule (`env.type != "production"`), the redirect target and the nginx snippet. NPM hosts get the redirect as `advanced_config` (ACME challenge exempt); DigitalOcean gets the name in its certificate (`certs.public_names(env)`) and a Caddy `redir`. Migration 0014 backfills existing environments.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy async, Alembic (raw SQL migrations), Postgres, httpx; Nginx Proxy Manager API; Caddy 2; React + Vitest for the Sirdar web.

Spec: `docs/superpowers/specs/2026-10-08-sirdar-home-redirect-design.md`.

## Global Constraints

- All copy, comments and docs use American English (color, behavior, recognize).
- Never use `AVNS_` in fake secrets or fixtures.
- API tests run from `sirdar/api` with `.venv/bin/python -m pytest`. Use your own test database so peer sessions are not disturbed: prefix every command with `SIRDAR_TEST_DB=sirdar_test_home` (the conftest requires the `sirdar_test` prefix and creates the database).
- Migration tests assert the head revision: after adding 0014, bump every `== "0013"` head assert in `tests/test_deploy_models.py` to `"0014"`.
- Production is `env.type == "production"`; never detect it by slots or target.
- `home` is NOT added to `envfile.SERVICES` (no container, no port allocation, no `.env` key). Code that iterates `envfile.SERVICES` stays as is; code that iterates `environment_services` rows handles `home` deliberately (see File Structure).
- 302, never 301 (browsers cache 301 forever; environment names are reused).
- Lint: `.venv/bin/ruff check src tests` must stay clean (line length 100).
- Baseline before this plan: `SIRDAR_TEST_DB=sirdar_test_homeplan .venv/bin/python -m pytest -q -x` → 2445 passed, 11 skipped (2026-10-08, about 22 minutes).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `sirdar/api/src/sirdar_api/deploy/home.py` | Create | `HOME`, `SERVICE_ORDER`, `wants_home`, `home_hostname`, `redirect_target`, `nginx_redirect` (pure, imports only `envfile`) |
| `sirdar/api/src/sirdar_api/deploy/environments.py` | Modify | `_insert` writes the `home` row; `_hostname` knows `home`; `services_of` orders by `home.SERVICE_ORDER`; PATCH refuses `services.home`, keeps `home` on portal's host/port, ignores it in the port-conflict check, rebuilds its hostname on a base-domain change |
| `sirdar/api/src/sirdar_api/deploy/pipeline.py` | Modify | LAN Blue/Green slot smoke (`public_hosts`) skips `home` (the app VM has no redirect; NPM does it) |
| `sirdar/api/src/sirdar_api/deploy/publish.py` | Modify | `APP_SERVICES` includes `home` (Switch traffic moves it with portal); `advanced_config(sp)`; `new_host_body`/`host_body` set it; `_forward_drift` checks the redirect for `home` |
| `sirdar/api/src/sirdar_api/deploy/smoke.py` | Modify | `home` passes only on a 302 whose `Location` starts with `https://portal.<base>/` |
| `sirdar/api/src/sirdar_api/deploy/certs.py` | Modify | `public_hosts(env)` and `public_names(env)` (service names + base domain when `wants_home`) |
| `sirdar/api/src/sirdar_api/deploy/do_provision.py` | Modify | `prepare` uses `certs.public_hosts(env)`; `_certificate` treats a recorded certificate missing a wanted name as due |
| `sirdar/api/src/sirdar_api/deploy/do_envs.py` | Modify | `SS_CERT_NAMES` from `certs.public_names(env)` |
| `sirdar/api/src/sirdar_api/dashboard/service.py` | Modify | `_public_hostnames` orders by `home.SERVICE_ORDER` (the certificate pill dials `home` too) |
| `sirdar/api/migrations/versions/0014_home_redirect.py` | Create | Backfill `home` rows; downgrade deletes them |
| `deploy/stack/proxy/Caddyfile` (repo root) | Modify | `@home` matcher + `redir … 302`; `@lbhealth` excludes the bare name |
| `sirdar/web/src/pages/environments/EnvSettings.tsx` | Modify | `home` is not an editable service row (it would always fail "Two services can't use the same port") |
| `sirdar/web/src/pages/environments/EnvOverview.tsx` | Modify | `home` row's address column reads "Redirects to the portal" |
| `sirdar/README.md` | Modify | Publishing + DigitalOcean paragraphs mention the bare name |
| Tests | Modify/Create | `tests/test_deploy_home.py` (new), `deploy_factories.py` (`with_home`), `fake_smoke.py` (bare-name redirect default + `respond`), and the suites named per task |

Places that iterate `environment_services` and what they do with `home` (checked against the code):

- `serialize.environment_out` → included (the Overview/Settings tables show it; the web handles it in Task 6).
- `pipeline._context` ports dict (`{**DEFAULT_PORTS, **rows}`) → harmless: `envfile.render_env` reads only `PORT_KEYS[s] for s in SERVICES`.
- `pipeline` LAN slot smoke `public_hosts` → excluded (Task 1). DO slot smoke builds from `certs.PUBLIC_SERVICES` → unchanged, excluded.
- `vmcommon.record_address(services=None)` → moves every row, `home` included (correct: single-VM DHCP environments). `services=("spaces",)`/`()` → untouched.
- `vms.address_in_use` → reads `host_ip` values; `home` duplicates portal's, no effect.
- `environments._free_ports` → reads ports in use; `home` duplicates portal's port, no effect.
- `publish.service_plans` → included (`is_public(env, "home")` is True: not an optional app).
- `publish._point` / `_fallback` / `switch_lan` → via `APP_SERVICES` (Task 1).
- `dashboard.service._public_hostnames` → included, ordered (Task 1).
- `api/routes/deploy.py:581` defaults → built from `envfile.SERVICES`, unchanged.
- The environment's cert-worker (`api/src/serversherpa/certs/worker.py`) reads `SS_CERT_NAMES` and renews by date only → no change; Sirdar's step 0 reissues a certificate that lacks the name (Task 5).

---

### Task 1: `home` rows: module, create, order, PATCH, Switch traffic

**Files:**
- Create: `sirdar/api/src/sirdar_api/deploy/home.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`_hostname` :163-166, `services_of` :194-198, `_insert` :228-254, `update` :757-786)
- Modify: `sirdar/api/src/sirdar_api/deploy/pipeline.py:836-839`
- Modify: `sirdar/api/src/sirdar_api/deploy/publish.py:895-897` (`APP_SERVICES`)
- Modify: `sirdar/api/src/sirdar_api/dashboard/service.py:258`
- Modify: `sirdar/api/tests/deploy_factories.py` (`make_environment`)
- Test: `sirdar/api/tests/test_deploy_home.py` (new), `tests/test_deploy_environments.py`, `tests/test_deploy_do_environments.py`, `tests/test_deploy_apps_api.py`, `tests/test_deploy_lan_switch.py`

**Interfaces:**
- Consumes: nothing new.
- Produces (`sirdar_api.deploy.home`):
  - `HOME: str = "home"`
  - `SERVICE_ORDER: tuple[str, ...]` = `("api", "portal", "home", "kiosk", "wiki", "spaces", "status", "mailpit")`
  - `wants_home(env) -> bool` (`env.type != "production"`)
  - `home_hostname(env) -> str` (`env.base_domain`)
  - `redirect_target(base_domain: str) -> str` (`f"https://portal.{base_domain}"`) — takes the base domain, not the env, because `ServicePlan` and the smoke test only know the hostname (which *is* the base domain for `home`).
  - `nginx_redirect(base_domain: str) -> str` (the NPM `advanced_config`, used in Task 4)
  - `deploy_factories.make_environment(..., with_home: bool = False)`
  - `publish.APP_SERVICES` now ends with `"home"`.

- [ ] **Step 1: Write the failing tests**

Create `sirdar/api/tests/test_deploy_home.py`:

```python
"""The bare environment name (deploy/home.py): which environments get it,
its name, where it redirects, and the order it sorts in."""

from types import SimpleNamespace

from sirdar_api.deploy import envfile, home


def _env(type_: str = "dev", domain: str = "demo.serversherpa.com"):
    return SimpleNamespace(type=type_, base_domain=domain,
                           apps=["wiki", "kiosk", "status", "mailpit"])


def test_every_type_but_production_gets_the_bare_name():
    assert [t for t in ("dev", "beta", "custom", "production") if home.wants_home(_env(t))] == [
        "dev", "beta", "custom"]


def test_name_and_target():
    env = _env()
    assert home.home_hostname(env) == "demo.serversherpa.com"
    assert home.redirect_target(env.base_domain) == "https://portal.demo.serversherpa.com"


def test_home_sorts_right_after_portal_and_is_not_a_stack_service():
    assert home.SERVICE_ORDER == ("api", "portal", "home", "kiosk", "wiki", "spaces", "status",
                                  "mailpit")
    assert home.HOME not in envfile.SERVICES


def test_the_nginx_redirect_spares_acme_challenges():
    assert home.nginx_redirect("demo.serversherpa.com") == (
        'if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
        "    return 302 https://portal.demo.serversherpa.com$request_uri;\n"
        "}")
```

In `tests/test_deploy_environments.py`, replace the expected rows in `test_create_new_generates_everything` (lines 52-59) with:

```python
    assert [(r.service, r.host_ip, r.port, r.hostname, r.proxied) for r in rows] == [
        ("api", "127.0.0.1", 8000, "api.qa.serversherpa.com", False),
        ("portal", "127.0.0.1", 8091, "portal.qa.serversherpa.com", False),
        ("home", "127.0.0.1", 8091, "qa.serversherpa.com", False),
        ("kiosk", "127.0.0.1", 8090, "kiosk.qa.serversherpa.com", False),
        ("wiki", "127.0.0.1", 8096, "wiki.qa.serversherpa.com", False),
        ("spaces", "127.0.0.1", 9000, "spaces.qa.serversherpa.com", False),
        ("status", "127.0.0.1", 8095, "status.qa.serversherpa.com", False),
        ("mailpit", "127.0.0.1", 8025, None, False)]
```

Append to `tests/test_deploy_environments.py`:

```python
async def test_home_follows_portal_and_the_base_domain(db, target):
    env = await environments.create_new(db, get_settings(), **_new(), actor_id=None)
    await db.commit()
    changed = await environments.update(db, get_settings(), env, {
        "base_domain": "qa2.serversherpa.com",
        "services": {"portal": {"port": 8191, "host_ip": "10.0.0.9"}}})
    await db.commit()
    assert "services.home.port" not in changed and "services.home.host_ip" not in changed
    rows = {r.service: r for r in await environments.services_of(db, env.id)}
    assert (rows["home"].host_ip, rows["home"].port, rows["home"].hostname) == (
        "10.0.0.9", 8191, "qa2.serversherpa.com")


async def test_home_is_never_edited_on_its_own(db, target):
    env = await environments.create_new(db, get_settings(), **_new(), actor_id=None)
    await db.commit()
    with pytest.raises(EnvError) as exc:
        await environments.update(db, get_settings(), env,
                                  {"services": {"home": {"port": 9999}}})
    assert (exc.value.code, exc.value.extra) == ("service_unknown", {"service": "home"})


async def test_an_untouched_patch_does_not_trip_over_home_sharing_portal_s_port(db, target):
    env = await environments.create_new(db, get_settings(), **_new(), actor_id=None)
    await db.commit()
    assert await environments.update(db, get_settings(), env, {"keep_dumps": 4}) == [
        "keep_dumps"]
```

Append to `tests/test_deploy_do_environments.py`:

```python
async def test_a_dev_droplet_environment_gets_home_and_production_does_not(db):
    env = await make_do_environment(db)
    rows = {s.service: s for s in await environments.services_of(db, env.id)}
    assert (rows["home"].hostname, rows["home"].port) == ("uat9.serversherpa.com",
                                                          rows["portal"].port)
    prod = await make_do_environment(db, name="prod", type_="production", account="production",
                                     slots=None)
    assert "home" not in {s.service for s in await environments.services_of(db, prod.id)}
```

Append to `tests/test_deploy_lan_switch.py`:

```python
async def test_the_bare_name_follows_the_portal(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    await _switched(db, lan, "purple")
    bare = _host(publish_fakes, "lan9.serversherpa.com")
    portal = _host(publish_fakes, "portal.lan9.serversherpa.com")
    assert (bare["forward_host"], bare["forward_port"]) == (
        PURPLE_IP, portal["forward_port"])
    assert (await _hosts(db, lan))["home"] == PURPLE_IP
    publish_fakes.smoke.set("portal.lan9.serversherpa.com", 502)
    await _fails(db, lan, "orange")
    assert _host(publish_fakes, "lan9.serversherpa.com")["forward_host"] == PURPLE_IP
    assert (await _hosts(db, lan))["home"] == PURPLE_IP
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_home.py tests/test_deploy_environments.py tests/test_deploy_do_environments.py tests/test_deploy_lan_switch.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'sirdar_api.deploy.home'` (collection error for `test_deploy_home.py`), then the row lists without `home`.

- [ ] **Step 3: Create `deploy/home.py`**

```python
"""The bare environment name (demo.serversherpa.com): every environment
that isn't production answers on its base domain with a 302 to its portal,
same path and query. 302, not 301: browsers keep a 301 forever, and
environment names get reused.

It is a pseudo-service row in environment_services (`home`): hostname =
the base domain, host and port the portal's, never proxied by Cloudflare.
It has no container, port or .env key, so it is not in envfile.SERVICES."""

from sirdar_api.deploy import envfile

HOME = "home"
# The services' display and publish order: home right after portal.
SERVICE_ORDER = tuple(name for service in envfile.SERVICES
                      for name in ((service, HOME) if service == "portal" else (service,)))


def wants_home(env) -> bool:
    return env.type != "production"


def home_hostname(env) -> str:
    return env.base_domain


def redirect_target(base_domain: str) -> str:
    """Where the bare name sends a browser (the request URI is appended)."""
    return f"https://portal.{base_domain}"


def nginx_redirect(base_domain: str) -> str:
    """Nginx Proxy Manager's advanced config for the home proxy host. The
    if spares Let's Encrypt's HTTP-01 requests: a bare server-level return
    would answer before NPM's challenge location, and renewals would fail."""
    return ('if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
            f"    return 302 {redirect_target(base_domain)}$request_uri;\n"
            "}")
```

- [ ] **Step 4: `environments.py`**

Add `home,` to the `from sirdar_api.deploy import (...)` block (alphabetical, after `first_admins,`).

Replace `_hostname` (:163-166):

```python
def _hostname(env: Environment, service: str, domain: str) -> str | None:
    """A service's public name: none for mailpit, nor for an app that is off.
    home is the base domain itself."""
    if service == home.HOME:
        return domain if home.wants_home(env) else None
    return (f"{service}.{domain}" if service in envfile.PUBLIC_SERVICES
            and app_rules.is_public(env, service) else None)
```

Replace the body of `services_of` (:194-198):

```python
async def services_of(db: AsyncSession, env_id) -> list[EnvironmentService]:
    rows = await db.scalars(select(EnvironmentService)
                            .where(EnvironmentService.environment_id == env_id))
    order = {s: i for i, s in enumerate(home.SERVICE_ORDER)}
    return sorted(rows, key=lambda r: order.get(r.service, len(order)))
```

In `_insert`, after the `for service in envfile.SERVICES:` loop (before the secrets loop) add:

```python
    if home.wants_home(env):
        # The bare name redirects to the portal: same host and port as portal.
        db.add(EnvironmentService(environment_id=env.id, service=home.HOME, host_ip=host,
                                  port=ports["portal"], hostname=home.home_hostname(env),
                                  proxied=False))
```

In `update`, replace the block from `rows = {r.service: r ...}` through the base-domain hostname loop (:757-786) with:

```python
    rows = {r.service: r for r in await services_of(db, env.id)}
    service_fields = fields.get("services") or {}
    # home follows portal: it is never edited on its own
    unknown = sorted(set(service_fields) - (set(rows) - {home.HOME}))
    if unknown:
        raise EnvError("service_unknown", service=unknown[0])
    for service, patch in service_fields.items():
        # (loop body unchanged)
        ...
    home_row = rows.get(home.HOME)
    if home_row is not None and "portal" in rows:
        home_row.host_ip, home_row.port = rows["portal"].host_ip, rows["portal"].port
    _check_ports_unique({s: r.port for s, r in rows.items() if s != home.HOME})
    if env.base_domain != old_domain:
        for service, row in rows.items():
            row.hostname = _hostname(env, service, env.base_domain)
```

Keep the existing `for service, patch in service_fields.items():` loop body exactly as it is; only the `unknown` line, the home sync and the port-check filter are new.

- [ ] **Step 5: `pipeline.py`, `publish.py`, `dashboard/service.py`**

`pipeline.py`: add `home,` to the `from sirdar_api.deploy import (...)` block (after `first_admins,`). In the Blue/Green branch (:836-839) change the filter to:

```python
        hosts = [{"service": r.service, "hostname": r.hostname,
                  "path": smoke.PATHS.get(r.service, "/"), "port": r.port}
                 for r in service_rows if r.hostname and r.service not in ("spaces", home.HOME)
                 and app_rules.is_public(env, r.service)]
```

and extend the comment above it: `# (no home: the app VM has no redirect; NPM makes it)`.

`publish.py`: add `home,` to the `from sirdar_api.deploy import (...)` block (after `envfile,`). Replace `APP_SERVICES` (:897):

```python
# Switch traffic on the LAN (deploy phase 8b): these follow the live app VM;
# spaces stays on the data VM. home (the bare name) goes where portal goes.
APP_SERVICES = (*(s for s in envfile.SERVICES if s != "spaces"), home.HOME)
```

`dashboard/service.py`: add `home,` to the `from sirdar_api.deploy import (...)` block (after `envfile,`) and in `_public_hostnames` replace the `order = ...` line with:

```python
    order = {s: i for i, s in enumerate(home.SERVICE_ORDER)}
```

If `envfile` is now unused in `dashboard/service.py`, `ruff` will say so; remove the import then.

- [ ] **Step 6: `deploy_factories.make_environment` gets `with_home`**

Change the signature to add `with_home: bool = False` (last keyword) and, after the `for service in envfile.SERVICES:` loop, add:

```python
    if with_home:
        db.add(EnvironmentService(
            environment_id=env.id, service="home", host_ip=host,
            port=envfile.DEFAULT_PORTS["portal"], proxied=False, hostname=env.base_domain))
```

(The default stays False so the many publish tests built on `make_environment` keep their six names.)

- [ ] **Step 7: Update the tests that count rows of a `create_new` environment**

`tests/test_deploy_apps_api.py`:

```python
def _ports(body) -> dict[str, int]:
    return {s["service"]: s["port"] for s in body["services"] if s["service"] != "home"}
```

and in the base-domain PATCH test (:185-188) the expected dict gains `"home": "qa2.serversherpa.com"`:

```python
    assert names == {"api": "api.qa2.serversherpa.com", "portal": "portal.qa2.serversherpa.com",
                     "home": "qa2.serversherpa.com",
                     "kiosk": "kiosk.qa2.serversherpa.com", "wiki": None,
                     "spaces": "spaces.qa2.serversherpa.com", "status": None, "mailpit": None}
```

`tests/test_deploy_lan_switch.py`, `test_each_service_keeps_its_port_on_the_new_slot`: replace the uniqueness assert with

```python
    named = {n: p for n, p in ports.items() if n != "lan9.serversherpa.com"}
    assert len(set(named.values())) == len(named)          # one port per service
    assert ports["lan9.serversherpa.com"] == ports["portal.lan9.serversherpa.com"]
```

and in `test_a_database_failure_while_putting_back_says_both` change `"1 of 6 public URLs didn't answer: portal."` to `"1 of 7 public URLs didn't answer: portal."` (the bare name is the seventh URL).

- [ ] **Step 8: Run the tests, then the whole suite**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_home.py tests/test_deploy_environments.py tests/test_deploy_do_environments.py tests/test_deploy_lan_switch.py tests/test_deploy_apps_api.py`
Expected: PASS.

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q && .venv/bin/ruff check src tests`
Expected: all pass, ruff clean. A failure elsewhere can only be a test that lists or counts the services of an environment made by `create_new`/`adopt`; fix the expectation by the same rule (a `home` row right after `portal`, sharing portal's host and port, hostname = base domain; none for production). Never change the feature to fit an old count.

- [ ] **Step 9: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/home.py sirdar/api/src/sirdar_api/deploy/environments.py \
  sirdar/api/src/sirdar_api/deploy/pipeline.py sirdar/api/src/sirdar_api/deploy/publish.py \
  sirdar/api/src/sirdar_api/dashboard/service.py sirdar/api/tests
git commit -m "feat(sirdar): home rows for the bare environment name, kept on portal's host and port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0014 backfills `home` rows

**Files:**
- Create: `sirdar/api/migrations/versions/0014_home_redirect.py`
- Test: `sirdar/api/tests/test_deploy_models.py` (new test + bump the five `"0013"` head asserts at :427, :595, :652, :871, :913)

**Interfaces:**
- Consumes: the `home` row shape from Task 1 (`service='home'`, hostname = base domain, portal's host_ip/port, `proxied=false`).
- Produces: revision `"0014"` (down_revision `"0013"`), the new head.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_deploy_models.py`:

```python
async def test_migration_0014_adds_home_to_every_non_production_environment():
    """Upgrade: a home row (base domain, the portal's host and port) for each
    non-production environment with a portal row and no home row yet.
    Downgrade: home rows go (their managed records stay; the next publish
    under the old code drops them as stale)."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    _alembic("downgrade", "0013")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            def env(name, type_="dev", target="esxi", extra_cols="", extra_vals=""):
                return conn.execute(
                    "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip"
                    f"{extra_cols}) VALUES (%s, %s, %s, %s, '10.0.0.2'{extra_vals}) "
                    "RETURNING id", (name, type_, target, f"{name}.serversherpa.com")
                ).fetchone()[0]

            def portal(env_id):
                conn.execute(
                    "INSERT INTO environment_services (environment_id, service, host_ip, port, "
                    "hostname) VALUES (%s, 'portal', '10.10.48.40', 8191, %s)",
                    (env_id, "portal.x.serversherpa.com"))

            demo = env("demo")
            portal(demo)
            kept = env("kept", type_="beta", target="ssh")
            portal(kept)
            conn.execute(
                "INSERT INTO environment_services (environment_id, service, host_ip, port, "
                "hostname) VALUES (%s, 'home', '10.0.0.9', 9999, 'old.example.com')", (kept,))
            env("bare", type_="custom", target="ssh")            # no portal row: no home
            prod = env("prod", type_="production", target="digitalocean",
                       extra_cols=", slots", extra_vals=", '{blue,green}'")
            portal(prod)
        _alembic("upgrade", "head")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0014"
            homes = conn.execute(
                "SELECT e.name, s.host_ip, s.port, s.hostname, s.proxied FROM environment_services s "
                "JOIN environments e ON e.id = s.environment_id WHERE s.service = 'home' "
                "ORDER BY e.name").fetchall()
            assert homes == [("demo", "10.10.48.40", 8191, "demo.serversherpa.com", False),
                             ("kept", "10.0.0.9", 9999, "old.example.com", False)]
        _alembic("downgrade", "0013")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM environment_services "
                                "WHERE service = 'home'").fetchone()[0] == 0
            assert conn.execute("SELECT count(*) FROM environment_services "
                                "WHERE service = 'portal'").fetchone()[0] == 3
    finally:
        _alembic("upgrade", "head")
```

Bump the five existing `== "0013"` head asserts in the same file to `== "0014"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_models.py -k "0014 or migration"`
Expected: FAIL — the new test sees version `0013` and no home rows; the bumped asserts see `0013`.

- [ ] **Step 3: Write the migration**

`sirdar/api/migrations/versions/0014_home_redirect.py`:

```python
"""The bare environment name (deploy/home.py): every environment that
isn't production gets a home row in environment_services (hostname = its
base domain, host and port the portal's), so its next publish adds the A
record, the proxy host and the redirect to its portal. No schema change:
managed_records keys on (environment_id, service, kind) already.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-08
"""
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO environment_services (environment_id, service, host_ip, port, hostname,
                                          proxied)
        SELECT e.id, 'home', p.host_ip, p.port, e.base_domain, false
          FROM environments e
          JOIN environment_services p ON p.environment_id = e.id AND p.service = 'portal'
         WHERE e.type <> 'production'
        ON CONFLICT (environment_id, service) DO NOTHING;
    """)


def downgrade() -> None:
    # Managed records for home stay: the code below 0014 sees them as stale
    # on the next publish and removes what Sirdar created.
    op.execute("DELETE FROM environment_services WHERE service = 'home';")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_models.py`
Expected: PASS.

Then the whole suite: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/migrations/versions/0014_home_redirect.py sirdar/api/tests/test_deploy_models.py
git commit -m "feat(sirdar): migration 0014 gives existing non-production environments their home row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Smoke test: the bare name must be a 302 to its portal

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/smoke.py` (docstring, `_check` :54-77)
- Modify: `sirdar/api/tests/fake_smoke.py`
- Test: `sirdar/api/tests/test_deploy_smoke.py`

**Interfaces:**
- Consumes: `home.HOME`, `home.redirect_target(base_domain)` (Task 1).
- Produces:
  - `smoke._check` result for `home`: ok only for `status == 302` and `Location` starting with `redirect_target(hostname) + "/"`; details `"HTTP 302 to the portal"` / `"HTTP <code>, not a redirect to the portal"`.
  - `fake_smoke.is_bare(hostname: str) -> bool`, `fake_smoke.portal_redirect(request) -> httpx.Response`, `fake_smoke.respond(request, status: int) -> httpx.Response` (used by Task 5's DigitalOcean tests).
  - `FakeSmoke`: with no answers set for a host, a bare name answers the portal redirect (as NPM/Caddy do); answers may be `(status, location)` tuples.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_deploy_smoke.py`:

```python
HOME = [("home", "uat2.serversherpa.com")]


async def _home(fake):
    return (await smoke.run(HOME, "10.10.48.6", transport=fake.transport(), attempts=1))[0]


async def test_the_bare_name_passes_only_as_a_302_to_its_portal():
    fake = FakeSmoke()                      # a bare name redirects by default, like NPM
    result = await _home(fake)
    assert (result.ok, result.url, result.detail) == (
        True, "https://uat2.serversherpa.com/", "HTTP 302 to the portal")
    assert fake.requests[0].headers["host"] == "uat2.serversherpa.com"
    for answer in (200, (301, "https://portal.uat2.serversherpa.com/"),
                   (302, "https://elsewhere.example/"),
                   (302, "https://portal.uat2.serversherpa.com.evil.example/"),
                   (302, "")):
        fake.set("uat2.serversherpa.com", answer)
        result = await _home(fake)
        code = answer if isinstance(answer, int) else answer[0]
        assert (result.ok, result.detail) == (
            False, f"HTTP {code}, not a redirect to the portal"), answer


async def test_a_service_name_still_passes_on_any_2xx_or_3xx():
    fake = FakeSmoke()
    fake.set("portal.uat2.serversherpa.com", (302, "https://anywhere.example/"))
    results = await _run(fake, attempts=1)
    assert [r.ok for r in results] == [True, True, True]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_smoke.py`
Expected: FAIL — the default FakeSmoke answers 200 for the bare name (`HTTP 200`, ok True), and a tuple answer raises in `httpx.Response(answer)`.

- [ ] **Step 3: Teach FakeSmoke the bare name**

In `tests/fake_smoke.py`, update the docstring and add the helpers and handler changes:

```python
"""Answers the smoke test's requests by their Host header: a status code, a
(status, Location) pair, or "tls" (certificate didn't verify), "down"
(refused) or "slow" (timeout). Each hostname's answers are used in turn;
the last one repeats. A hostname with no answers gets the default, except a
bare environment name, which redirects to its portal as NPM and Caddy do."""

import ssl

import httpx

from sirdar_api.deploy import envfile


def is_bare(hostname: str) -> bool:
    """An environment's own name: no service label in front."""
    return hostname.split(".", 1)[0] not in envfile.SERVICES


def portal_redirect(request: httpx.Request) -> httpx.Response:
    host = request.headers["host"]
    return httpx.Response(302, headers={
        "location": f"https://portal.{host}{request.url.raw_path.decode()}"})


def respond(request: httpx.Request, status: int) -> httpx.Response:
    """`status` for a service's name; a bare name redirects to its portal
    while `status` is a pass (below 400)."""
    if status < 400 and is_bare(request.headers["host"]):
        return portal_redirect(request)
    return httpx.Response(status)
```

and in `FakeSmoke.handler` replace the answer lookup and the final return:

```python
        queue = self.answers.get(request.headers["host"])
        answer = (queue.pop(0) if len(queue) > 1 else queue[0]) if queue else None
        if answer is None:
            return respond(request, self.default)
        # ("tls", "down" and "slow" branches unchanged)
        ...
        if isinstance(answer, tuple):
            status, location = answer
            return httpx.Response(status, headers={"location": location} if location else {})
        return httpx.Response(answer)
```

- [ ] **Step 4: The strict rule in `smoke.py`**

Add `from sirdar_api.deploy import home` after `import httpx`. Update the module docstring sentence "Redirects are not followed: 200–399 passes." to:

```
extra_hosts too. Redirects are not followed: 200–399 passes, except for the
bare environment name (home), which must answer 302 with a Location on its
portal, so a host that serves the portal directly fails. Details are
```

Replace the last line of `_check` (`return SmokeResult(service, url, 200 <= resp.status_code < 400, ...)`) with:

```python
    if service == home.HOME:
        wanted = home.redirect_target(hostname) + "/"
        if resp.status_code == 302 and resp.headers.get("location", "").startswith(wanted):
            return SmokeResult(service, url, True, "HTTP 302 to the portal")
        return SmokeResult(service, url, False,
                           f"HTTP {resp.status_code}, not a redirect to the portal")
    return SmokeResult(service, url, 200 <= resp.status_code < 400, f"HTTP {resp.status_code}")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_smoke.py tests/test_deploy_lan_switch.py tests/test_deploy_publish_steps.py`
Expected: PASS (the LAN switch runs the bare name's smoke check against the fake's default redirect).

Then: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q && .venv/bin/ruff check src tests`
Expected: PASS, ruff clean.

- [ ] **Step 6: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/smoke.py sirdar/api/tests/fake_smoke.py \
  sirdar/api/tests/test_deploy_smoke.py
git commit -m "feat(sirdar): the bare name's smoke check passes only on a 302 to its portal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: NPM: the redirect as the home host's advanced config, with drift repair

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/publish.py` (`_forward_drift` :264-269, `SPACES_ADVANCED` :488, `new_host_body` :675-682, `host_body` :685-694)
- Test: `sirdar/api/tests/test_deploy_publish_steps.py`, `sirdar/api/tests/test_deploy_lan_switch.py`

**Interfaces:**
- Consumes: `home.HOME`, `home.nginx_redirect(base_domain)` (Task 1); `make_environment(..., with_home=True)` (Task 1).
- Produces: `publish.advanced_config(sp: ServicePlan) -> str` (`SPACES_ADVANCED` for spaces, `home.nginx_redirect(sp.hostname)` for home, `""` otherwise). `proxy_status` reports `"Sirdar will change the redirect."` for a home host whose `advanced_config` differs, and `ensure_proxy` rewrites it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_deploy_publish_steps.py`:

```python
REDIRECT = ('if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
            "    return 302 https://portal.uat2.serversherpa.com$request_uri;\n"
            "}")


@pytest.fixture
async def home_env(db, secrets_key, publish_fakes):  # noqa: F811
    publish_fakes.npm.now = NOW
    await configure(db)
    return await make_environment(db, name="uat2", host="10.10.48.63", with_home=True)


def _bare(fake_npm) -> dict:
    return next(h for h in fake_npm.hosts.values()
                if h["domain_names"] == ["uat2.serversherpa.com"])


async def test_the_bare_name_gets_a_redirect_host_with_its_own_certificate(db, home_env,
                                                                         publish_fakes):
    lines = await _run(db, home_env, "proxy")
    bare = _bare(publish_fakes.npm)
    assert bare["advanced_config"] == REDIRECT
    assert (bare["forward_host"], bare["forward_port"]) == ("10.10.48.63", 8091)
    assert bare["ssl_forced"] and publish_fakes.npm.certs[bare["certificate_id"]][
        "domain_names"] == ["uat2.serversherpa.com"]
    others = [h for h in publish_fakes.npm.hosts.values() if h is not bare]
    assert {h["advanced_config"] for h in others} == {"", "client_max_body_size 0;"}
    assert ("uat2.serversherpa.com: created a proxy host to 10.10.48.63:8091\n" in lines)
    order = [line.split(":")[0] for line in lines if "created a proxy host" in line]
    assert order[:3] == ["api.uat2.serversherpa.com", "portal.uat2.serversherpa.com",
                         "uat2.serversherpa.com"]


async def test_a_redirect_changed_by_hand_is_put_back(db, home_env, publish_fakes):
    await _run(db, home_env, "proxy")
    _bare(publish_fakes.npm)["advanced_config"] = "return 301 https://elsewhere.example;"
    state = await publish.inspect(db, home_env, get_settings())
    bare = next(s for s in state["services"] if s["service"] == "home")
    assert (bare["proxy"]["state"], bare["proxy"]["detail"]) == (
        "update", "Sirdar will change the redirect.")
    lines = await _run(db, home_env, "proxy")
    assert _bare(publish_fakes.npm)["advanced_config"] == REDIRECT
    assert "uat2.serversherpa.com: proxy host now goes to 10.10.48.63:8091\n" in lines


async def test_other_hosts_keep_their_own_advanced_config(db, home_env, publish_fakes):
    await _run(db, home_env, "proxy")
    api = next(h for h in publish_fakes.npm.hosts.values()
               if h["domain_names"] == ["api.uat2.serversherpa.com"])
    api["advanced_config"] = "proxy_read_timeout 300;"
    writes = len(_writes(publish_fakes.npm))
    await _run(db, home_env, "proxy")
    assert api["advanced_config"] == "proxy_read_timeout 300;"
    assert len(_writes(publish_fakes.npm)) == writes
```

Append to `tests/test_deploy_lan_switch.py`:

```python
async def test_a_switch_keeps_the_redirect_on_the_bare_name(db, lan, publish_fakes):  # noqa: F811
    await _switched(db, lan, "orange")
    await _switched(db, lan, "purple")
    assert ("return 302 https://portal.lan9.serversherpa.com$request_uri;"
            in _host(publish_fakes, "lan9.serversherpa.com")["advanced_config"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_publish_steps.py tests/test_deploy_lan_switch.py -k "bare or redirect or advanced"`
Expected: FAIL — `advanced_config` is `""` on the home host; the drift test sees state `ok`.

- [ ] **Step 3: Implement in `publish.py`**

Move `SPACES_ADVANCED = "client_max_body_size 0;"` up next to `ServicePlan` (right after the `ServicePlan` dataclass) and add:

```python
SPACES_ADVANCED = "client_max_body_size 0;"


def advanced_config(sp: ServicePlan) -> str:
    """The NPM advanced config Sirdar writes for a service: uploads without a
    size cap for spaces, the redirect to the portal for the bare name."""
    if sp.service == "spaces":
        return SPACES_ADVANCED
    if sp.service == home.HOME:
        return home.nginx_redirect(sp.hostname)
    return ""
```

(Delete the old `SPACES_ADVANCED` line at :488.)

Replace `_forward_drift`:

```python
def _forward_drift(host: ProxyHost, sp: ServicePlan) -> list[str]:
    checks = [("the scheme", host.forward_scheme, "http"),
              ("the forward host", host.forward_host, sp.host_ip),
              ("the forward port", host.forward_port, sp.port),
              ("WebSockets", host.allow_websocket_upgrade, True)]
    if sp.service == home.HOME:
        # only the bare name's advanced config is Sirdar's; others keep theirs
        checks.append(("the redirect", host.raw.get("advanced_config") or "",
                       advanced_config(sp)))
    return [name for name, have, want in checks if have != want]
```

In `new_host_body` replace the `advanced_config` entry with `"advanced_config": advanced_config(sp),`.

In `host_body`, after `body.update(forward_scheme=..., allow_websocket_upgrade=True)` add:

```python
    if sp.service == home.HOME:
        body["advanced_config"] = advanced_config(sp)
```

and extend its docstring: `The bare name's advanced config is Sirdar's (the redirect) and is rewritten.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_publish_steps.py tests/test_deploy_lan_switch.py tests/test_deploy_publish.py tests/test_deploy_publish_api.py`
Expected: PASS.

Then: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q && .venv/bin/ruff check src tests`
Expected: PASS, ruff clean.

- [ ] **Step 5: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/publish.py sirdar/api/tests/test_deploy_publish_steps.py \
  sirdar/api/tests/test_deploy_lan_switch.py
git commit -m "feat(sirdar): NPM serves the bare name as a 302 to the portal, ACME challenges spared

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: DigitalOcean: the bare name in the certificate, the smoke test and Caddy

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/certs.py` (`public_names` :36-37)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_provision.py` (imports :56-58, `prepare` :224-225, `_certificate` :996-1001)
- Modify: `sirdar/api/src/sirdar_api/deploy/do_envs.py` (imports :21-22, `env_extra` :360-363)
- Modify: `deploy/stack/proxy/Caddyfile` (repo root)
- Test: `tests/test_deploy_home.py`, `tests/test_deploy_acme.py`, `tests/test_deploy_do_provision.py`, `tests/test_deploy_do_switch_and_remove.py`, `tests/test_deploy_apps_api.py`, `tests/test_deploy_do_environments.py`, `tests/test_deploy_pipeline_do.py`, `tests/test_deploy_stack_external.py`

**Interfaces:**
- Consumes: `home.wants_home(env)` (Task 1); `fake_smoke.respond(request, status)` (Task 3); `smoke` strict rule for `home` (Task 3).
- Produces:
  - `certs.public_hosts(env) -> tuple[tuple[str, str], ...]`: `(service, hostname)` for each running public service in `certs.PUBLIC_SERVICES` order, then `("home", env.base_domain)` when `home.wants_home(env)`.
  - `certs.public_names(env) -> tuple[str, ...]`: the hostnames of `public_hosts(env)`. **Signature change**: it took a base-domain string; its only caller was `tests/test_deploy_acme.py`.
  - `DoContext.hosts` / `.names` and `SS_CERT_NAMES` come from these, so the certificate, the cert-worker and the LB smoke test name the same list.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_deploy_home.py`:

```python
from sirdar_api.deploy import certs  # noqa: E402


def test_droplet_names_end_with_the_bare_name_except_on_production():
    assert certs.public_names(_env()) == (
        "api.demo.serversherpa.com", "portal.demo.serversherpa.com",
        "kiosk.demo.serversherpa.com", "wiki.demo.serversherpa.com",
        "status.demo.serversherpa.com", "demo.serversherpa.com")
    assert certs.public_hosts(_env())[-1] == ("home", "demo.serversherpa.com")
    assert "demo.serversherpa.com" not in certs.public_names(_env("production"))
    off = SimpleNamespace(type="dev", base_domain="demo.serversherpa.com", apps=["mailpit"])
    assert certs.public_names(off) == ("api.demo.serversherpa.com",
                                       "portal.demo.serversherpa.com", "demo.serversherpa.com")
```

(Move the `certs` import to the top of the file with the others; the `noqa` is only for this snippet's placement.)

In `tests/test_deploy_acme.py` replace line 25:

```python
NAMES = tuple(f"{s}.uat9.serversherpa.com" for s in certs.PUBLIC_SERVICES)
```

In `tests/test_deploy_do_provision.py`, `test_the_first_run_builds_everything` (:79-80):

```python
    assert sorted(cert["dns_names"]) == sorted(
        [*(f"{s}.uat9.serversherpa.com" for s in ("api", "portal", "kiosk", "wiki", "status")),
         "uat9.serversherpa.com"])
```

and append:

```python
async def test_a_certificate_without_the_bare_name_is_replaced_now(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = fake.certificates.values()
    old["dns_names"] = [n for n in old["dns_names"] if n != "uat9.serversherpa.com"]
    await do_build.run()
    (new,) = fake.certificates.values()                 # the old one is retired
    assert new["id"] != old["id"] and "uat9.serversherpa.com" in new["dns_names"]
    log = do_build.log()
    assert (f"Certificate {old['name']} doesn't cover uat9.serversherpa.com; "
            "Sirdar replaces it.") in log
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == new["id"]
```

(`fake.certificates` values are the stored dicts, so editing `dns_names` changes what `GET /certificates/{id}` returns. If two runs in the same minute give the new certificate the old one's `ss-uat9-<yyyymmddhhmm>` name, that is fine: ids differ.)

In `tests/test_deploy_do_switch_and_remove.py`, make `_answer` follow the bare-name rule:

```python
from .fake_smoke import respond


def _answer(status: int):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return respond(request, status)

    return httpx.MockTransport(handler), seen
```

and add to `test_switch_traffic_to_the_slot` (after its host-set assertion):

```python
    assert "uat9.serversherpa.com" in {r.headers["host"] for r in seen}
```

In `tests/test_deploy_apps_api.py` (:210-211 and :222-223):

```python
    assert values["SS_CERT_NAMES"] == ("api.uat9.serversherpa.com,portal.uat9.serversherpa.com,"
                                       "status.uat9.serversherpa.com,uat9.serversherpa.com")
```

```python
    assert ctx.names == ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com",
                         "wiki.uat9.serversherpa.com", "uat9.serversherpa.com")
```

In `tests/test_deploy_do_environments.py` (:252-253):

```python
        "SS_CERT_NAMES": ",".join([*(f"{s}.uat9.serversherpa.com"
                                     for s in ("api", "portal", "kiosk", "wiki", "status")),
                                   "uat9.serversherpa.com"]),
```

In `tests/test_deploy_pipeline_do.py` after the `SS_CERT_NAMES=` prefix assert (:95) add:

```python
    assert "status.uat9.serversherpa.com,uat9.serversherpa.com\n" in text
```

In `tests/test_deploy_stack_external.py`, `test_caddyfile_routes_in_order`: insert `"redir @home https://portal.{$STACK_DOMAIN}{uri} 302",` into `order` between the ACME line and the `@plain` line, and add:

```python
    assert "not host *.{$STACK_DOMAIN} {$STACK_DOMAIN}" in text
    assert "@home host {$STACK_DOMAIN}" in text
```

In `test_caddy_routes_in_a_container`, after the `308 https://portal.uat9.serversherpa.com/x` assert, add:

```python
        bare = ("-H", "Host: uat9.serversherpa.com")
        assert curl(*bare, "http://172.30.9.2/x?y=1") == (
            "302 https://portal.uat9.serversherpa.com/x?y=1")
        assert curl(*bare, "-H", "X-Forwarded-Proto: http", "http://172.30.9.2/x") == (
            "302 https://portal.uat9.serversherpa.com/x")
        assert curl(*bare, "http://172.30.9.2/healthz").startswith("302")
        assert curl(*bare, "http://172.30.9.2/.well-known/acme-challenge/tok",
                    body=True).strip() == "acme-token"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_home.py tests/test_deploy_acme.py tests/test_deploy_do_provision.py tests/test_deploy_do_switch_and_remove.py tests/test_deploy_apps_api.py tests/test_deploy_do_environments.py tests/test_deploy_pipeline_do.py tests/test_deploy_stack_external.py`
Expected: FAIL — `certs.public_hosts` missing / `public_names` takes a string; the certificate lacks `uat9.serversherpa.com`; the Caddyfile has no `@home`.

- [ ] **Step 3: `certs.py`**

Add `from sirdar_api.deploy import acme, home, outbound, vault` and `from sirdar_api.deploy import apps as app_rules` (no cycle: `apps` imports only `envfile`, `home` only `envfile`). Replace `public_names`:

```python
def public_hosts(env) -> tuple[tuple[str, str], ...]:
    """(service, hostname) a droplet environment serves: its running apps'
    names, then the bare name (home) unless it is production. The
    certificate, the cert-worker (SS_CERT_NAMES) and the load balancer's
    smoke test all use this list."""
    found = [(s, f"{s}.{env.base_domain}") for s in PUBLIC_SERVICES
             if app_rules.is_public(env, s)]
    if home.wants_home(env):
        found.append((home.HOME, home.home_hostname(env)))
    return tuple(found)


def public_names(env) -> tuple[str, ...]:
    return tuple(name for _, name in public_hosts(env))
```

Update the module docstring's "covering exactly the public names" to "covering exactly public_names(env) (the running apps' names and, outside production, the bare name)".

- [ ] **Step 4: `do_provision.py`**

In `prepare` replace the `hosts=` argument with:

```python
        hosts=certs.public_hosts(env),
```

Remove `apps as app_rules,` from the import block if `ruff` reports it unused (its only use was this line).

In `_certificate`, replace from `now = self._now()` through the `else:` line with:

```python
        now = self._now()
        when = certs.not_after(best) if best else None
        # A certificate that lacks a wanted name (the bare name, added after it
        # was issued) is due now, not 14 days before it expires.
        missing = sorted(set(ctx.names) - set(best.get("dns_names") or [])) if best else []
        if (when is not None and not missing
                and certs.days_left(when, now) > certs.SIRDAR_RENEW_DAYS):
            out(f"Certificate {best['name']}: valid until {when:%Y-%m-%d}.\n")
        else:
            if missing:
                out(f"Certificate {best['name']} doesn't cover {', '.join(missing)}; "
                    "Sirdar replaces it.\n")
```

(The rest of the `else:` branch — Cloudflare check, `issue_dns01`, upload, record — is unchanged; `_load_balancer` then switches to the new certificate and `_retire_certificates` deletes the old one, as for any renewal.) Update the docstring's first line to: `The certificate to serve (recorded; renewed at 14 days or fewer, or now when it lacks a wanted name).`

- [ ] **Step 5: `do_envs.py`**

Replace the `SS_CERT_NAMES` entry:

```python
        # what do_provision's certificate covers: the running apps and the bare name
        "SS_CERT_NAMES": ",".join(certs.public_names(env)),
```

Remove `from sirdar_api.deploy import apps as app_rules` if `ruff` reports it unused.

- [ ] **Step 6: `deploy/stack/proxy/Caddyfile`**

Header comment, replace lines 3-5 with:

```
# order: Caddy's own health, the load balancer's health check (any host
# outside the environment's names: the API's health), Let's Encrypt HTTP-01
# for the cert-worker, the bare environment name to its portal (302: names
# are reused, and browsers keep a 301 forever), plain HTTP to HTTPS, then
# each public name.
```

`@lbhealth` becomes:

```
	@lbhealth {
		path /healthz
		not host *.{$STACK_DOMAIN} {$STACK_DOMAIN}
	}
```

Add after `@status host status.{$STACK_DOMAIN}`:

```
	# production has the rule too, but no DNS record or certificate name, so
	# nothing reaches it
	@home host {$STACK_DOMAIN}
```

and in `route`, between the ACME line and `redir @plain …`:

```
		redir @home https://portal.{$STACK_DOMAIN}{uri} 302
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_home.py tests/test_deploy_acme.py tests/test_deploy_do_provision.py tests/test_deploy_do_switch_and_remove.py tests/test_deploy_apps_api.py tests/test_deploy_do_environments.py tests/test_deploy_pipeline_do.py tests/test_deploy_stack_external.py tests/test_deploy_do_renewals.py`
Expected: PASS (`test_caddy_routes_in_a_container` skips without Docker and `SS_STACK_E2E=1`).

If Docker is available, also run: `cd sirdar/api && SS_STACK_E2E=1 SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q tests/test_deploy_stack_external.py -k caddy_routes`
Expected: PASS (proves the Caddyfile parses and `not host a b` is valid).

Then: `cd sirdar/api && SIRDAR_TEST_DB=sirdar_test_home .venv/bin/python -m pytest -q && .venv/bin/ruff check src tests`
Expected: PASS, ruff clean. Any other DigitalOcean test failure will be a hard-coded five-name list or an all-200 smoke transport; fix it with `certs.public_names`/the sixth name or `fake_smoke.respond`, never by dropping the name.

- [ ] **Step 8: Commit**

```bash
git add sirdar/api/src/sirdar_api/deploy/certs.py sirdar/api/src/sirdar_api/deploy/do_provision.py \
  sirdar/api/src/sirdar_api/deploy/do_envs.py deploy/stack/proxy/Caddyfile sirdar/api/tests
git commit -m "feat(sirdar): droplets serve the bare name: certificate name, cert-worker list, Caddy 302

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web: `home` is not an editable service

**Files:**
- Modify: `sirdar/web/src/pages/environments/EnvSettings.tsx` (:44, :132-138, :162-165, :188-195, :325)
- Modify: `sirdar/web/src/pages/environments/EnvOverview.tsx` (:73-87)
- Modify: `sirdar/web/src/pages/environments/testData.ts` (`ENV.services`)
- Test: `sirdar/web/src/pages/environments/EnvSettings.test.tsx`, `EnvOverview.test.tsx`

**Interfaces:**
- Consumes: the API's `services` list now holds `{service: 'home', hostname: <base domain>, host_ip, port: <portal's>}` (Task 1).
- Produces: nothing for other tasks.

- [ ] **Step 1: Write the failing tests**

In `testData.ts`, give `ENV` its home row (right after portal, same port):

```ts
  services: [svc('api', 8000), svc('portal', 8091), { ...svc('home', 8091), hostname: 'uat.serversherpa.com' },
             svc('kiosk', 8090), svc('wiki', 8096), svc('spaces', 9000), svc('status', 8095), svc('mailpit', 8025)],
```

(Check `svc`'s `hostname` default first; keep whatever it sets for the other services.)

Append to `EnvSettings.test.tsx`:

```tsx
it('the bare name follows the portal: no row to edit, and it never trips the port check', async () => {
  const { onSaved } = open();
  expect(screen.queryByLabelText('home port')).toBeNull();
  await userEvent.clear(screen.getByLabelText('api port'));
  await userEvent.type(screen.getByLabelText('api port'), '8100');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { services: { api: { port: 8100 } } });
});
```

Append to `EnvOverview.test.tsx`:

```tsx
it('the bare name says where it goes', () => {
  render(<EnvOverview env={ENV} />);
  const services = screen.getByRole('table', { name: 'Services' });
  expect(within(services).getByText('https://uat.serversherpa.com')).toBeTruthy();
  expect(within(services).getByText('Redirects to the portal')).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sirdar/web && npx vitest run src/pages/environments/EnvSettings.test.tsx src/pages/environments/EnvOverview.test.tsx`
Expected: FAIL — a `home port` input exists and Save stops on "Two services can't use the same port."; no "Redirects to the portal" cell.

- [ ] **Step 3: `EnvSettings.tsx`**

Near the top of the module (after the imports) add:

```tsx
/** The bare name (home) follows the portal's address and port: never edited on its own. */
const editable = (env: Environment) => env.services.filter((s) => s.service !== 'home');
```

Then replace `env.services` with `editable(env)` in: `fromEnv` (:44), the validation loop (:132), the duplicate-port check (:163), `patchOf` (:189) and the Services `DataTable` rows (:325). No other change.

- [ ] **Step 4: `EnvOverview.tsx`**

In the Services rows' address cell, put the home case first:

```tsx
              s.service === 'home'
                ? <span className="cell-sub">Redirects to the portal</span>
                : cloud
                ? `:${s.port} on each droplet`
                : bluegreen && s.service !== 'spaces'
                ? `:${s.port} on the live app VM`
                : s.service === 'mailpit'
                ? <a href={`http://${s.host_ip}:${s.port}`} target="_blank" rel="noreferrer">{`${s.host_ip}:${s.port}`}</a>
                : `${s.host_ip}:${s.port}`,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sirdar/web && npx vitest run src/pages/environments && npx tsc --noEmit -p .`
Expected: PASS, no type errors. (If `ENV`'s extra row changes another test's count of service rows or ports, update that expectation: the home row is part of the record.)

- [ ] **Step 6: Commit**

```bash
git add sirdar/web/src/pages/environments
git commit -m "feat(sirdar-web): the bare name follows the portal: not editable, shown as a redirect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README

**Files:**
- Modify: `sirdar/README.md` (Publishing paragraph ~:248-264, DigitalOcean list ~:636-639)

**Interfaces:** none.

- [ ] **Step 1: Publishing paragraph**

After the sentence ending "…with the public name as SNI and Host." insert:

```markdown
Every environment that isn't production also answers on its bare base domain
(`demo.serversherpa.com`): a `home` row (hostname = the base domain, the
portal's host and port) gets an A record, a proxy host with its own
Let's Encrypt certificate, and NPM advanced config that answers
**302** to `https://portal.<base domain><same path and query>` (Let's Encrypt
challenge paths are spared so NPM can still renew). 302, not 301: browsers
keep a 301 forever, and environment names are reused. The smoke test expects
exactly that 302. The row follows the portal (Switch traffic, address and
port edits, a base-domain change) and isn't edited on its own; migration
0014 added it to existing environments, so their next publish creates it.
```

- [ ] **Step 2: DigitalOcean list**

Change the certificate bullet's text to say it covers the running apps' names "and, outside production, the bare base domain" and the Cloudflare bullet to "Cloudflare A records for the public names (and the bare base domain outside production), pointing at the load balancer." Add one sentence after the list: "Caddy on each droplet answers the bare name with a 302 to the portal. A certificate issued before the bare name existed is replaced on the next Update (step 0)."

- [ ] **Step 3: Commit**

```bash
git add sirdar/README.md
git commit -m "docs(sirdar): the bare environment name redirects to the portal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Live verify (after merge, not a task)

Deploy the branch to Tower, then publish `demo` (ESXi, single host):

- `dig +short demo.serversherpa.com` → the router's public IP.
- `curl -sI 'https://demo.serversherpa.com/x?y=1'` → `HTTP/2 302`, `location: https://portal.demo.serversherpa.com/x?y=1`, valid certificate.
- `curl -sI http://demo.serversherpa.com/.well-known/acme-challenge/nope` → NPM's challenge location (404), not the 302.
- Sirdar dashboard: the certificate pill lists `demo.serversherpa.com`.

## Baseline note

Baseline on `sirdar` at f133677c (2026-10-08): `2445 passed, 11 skipped, 1 warning in 1304.98s`. The full suite takes about 22 minutes: run single files while iterating and the whole suite once at the end of each task, in the foreground.
