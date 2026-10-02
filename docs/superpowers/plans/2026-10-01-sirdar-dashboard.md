# Sirdar Dashboard (Deployments overview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace Sirdar's placeholder Dashboard page (`/`) with a "Deployments" overview that matches the product owner's mockup. The overview has four parts:
- a Production section showing live traffic flowing into a load balancer, which routes to Blue or Green;
- Development, Beta and Custom environment cards;
- an expandable Infrastructure tree table;
- real data from a new `/api/dashboard` endpoint, plus a Demo toggle that fills everything with sample data.

**Hard constraints (product owner):**
- Change the Dashboard page only. Do NOT change the nav bar, the shell, the topbar or any other page.
- Scope every style under the dashboard root class (`.sd-dash`).
- GSAP is allowed; it is already a dependency. Use its free plugins (MotionPathPlugin) if useful.
- The "Deploy release", "Activate Green" and "Deploy to Dev/Beta" buttons are shown but **disabled**, with a tooltip/title "Coming in step 2". Deploying isn't built yet.

**Decisions:**
- Real data comes from deployment records (none exist until step 2, so environments show "No active deployment") plus DigitalOcean inventory when a DO token is configured.
- Demo mode returns a fixed sample that mirrors the mockup with ServerSherpa names.

## Global Constraints
- **Where to work:** only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/sirdar` (branch `sirdar`).
- **What not to do:**
  - Never cd into the main checkout.
  - Never run a bare `git stash`.
  - Never run `npm install` in `portal/`.
  - Never touch `serversherpa-dev`, the dev sirdar-db data, or ports 5434/8097/8098.
- **Testing:** TDD. Run the suites in the foreground:
  - `cd sirdar/api && .venv/bin/pytest -q`
  - `npm --prefix sirdar/web test`
  - `cd sirdar/web && npx tsc -p tsconfig.json --noEmit`
  - `npm --prefix sirdar/web run build`
- **Commits:** every message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Security:**
  - Never return or log the DO token.
  - Use the existing `deploy/digitalocean.py` client helpers and sanitized error reasons.
  - Permission is `dashboard:view`.
- **Copy:** American English.

---

### Task A: API — `GET /api/dashboard`

**Files:**
- Create: `sirdar/api/src/sirdar_api/dashboard/__init__.py`
- Create: `sirdar/api/src/sirdar_api/dashboard/service.py`
- Create: `sirdar/api/src/sirdar_api/dashboard/demo.py`
- Create: `sirdar/api/src/sirdar_api/api/routes/dashboard.py` and include it in `app.py`
- Modify: `deploy/digitalocean.py`, adding inventory helpers
- Tests: `tests/test_dashboard_api.py`, `tests/test_dashboard_inventory.py`

**Response shape** (`demo` query param: `?demo=1` returns the demo fixture):

```json
{
  "demo": false,
  "generated_at": "ISO",
  "health": {"status": "healthy|degraded|unknown", "label": "All systems healthy|… issues|No environments deployed"},
  "production": {
    "status": "active|inactive",
    "active_slot": "blue|green|null",
    "traffic": {"label": "Live traffic", "sub": "External users"},
    "load_balancer": {"label": "Load balancer", "sub": "Blue active|Green active|Not configured", "present": true},
    "slots": [
      {"id": "blue", "label": "Production Blue", "state": "active|standby|empty", "health": "healthy|degraded|unknown",
       "version": "v2.8.0|null", "instances": {"running": 3, "total": 3}, "traffic_pct": 100}
    ]
  },
  "environments": [
    {"id": "dev", "label": "Development", "state": "active|empty", "version": "…|null", "last_release": "…|null", "action_label": "Deploy to Dev"}
  ],
  "infrastructure": {
    "source": "digitalocean|none|demo",
    "error": "string|null",
    "tree": ["Node"]
  }
}
```

- `production.slots` always holds Blue and Green, in that order.
- `environments` holds Dev and Beta, then one entry per custom environment, in name order.

**Node:**
```json
{"id": "…", "name": "…", "kind": "environment|deployment|group|droplet|database|spaces|load_balancer",
 "type_label": "Environment|Deployment|Shared resources|Droplet|Managed PostgreSQL|Spaces|Load balancer",
 "status": "active|running|standby|healthy|available|inactive|stopped|provisioning|unknown",
 "status_label": "Active|Running|…", "region": "NYC3|—", "endpoint": "…|—",
 "badge": "Blue + Green|null", "dot": "green|gray|blue|null", "children": ["Node"]}
```

**Requirements:**
1. **Real mode.** There are no deployment records yet.
   - Production: `status: "inactive"`, `active_slot: null`. Both slots have `state: "empty"`, `version: null`, `instances {0, 0}` and `traffic_pct: 0`. The load balancer `sub` is "Not configured" unless the inventory finds a load balancer tagged `sirdar-env:production`.
   - Dev and Beta: `state: "empty"`, `last_release: null`. Add one environment per distinct custom env tag found in the inventory, as described next.
   - Health: `"unknown"`, with the label "No environments deployed" when nothing is active.
2. **Inventory** (only when a DO token is configured; otherwise `source: "none"`, `tree: []`):
   - Fetch `GET /v2/droplets?per_page=200`, `GET /v2/databases`, `GET /v2/load_balancers?per_page=200` and, if present, `GET /v2/volumes`. Skip volumes if the call is awkward. The droplets fetch must follow `links.pages.next` up to 5 pages.
   - Group resources by tags:
     - `sirdar-env:<env>`, where env is `production`, `dev`, `beta` or a custom name;
     - `sirdar-slot:blue|green` for production deployments;
     - `sirdar-shared` for shared production resources (db and spaces).
   - Tree:
     - Environment node (`Production`, `Development`, `Beta`, custom names title-cased)
       - for production: Blue and Green deployment nodes, each holding its droplets
       - "Shared production resources" (`kind: group`, badge "Blue + Green")
     - **Untagged** node, last, for resources without a `sirdar-env` tag (`kind: group`, `type_label` "Untagged resources").
   - Droplet status mapping:
     - `active` → `running` / "Running"
     - `off` → `stopped` / "Stopped"
     - `new` → `provisioning` / "Provisioning"
     - archive or anything else → `unknown`
   - Droplet endpoint: private IPv4 if present, else public IPv4.
   - Databases: `online` → `healthy` / "Healthy"; others → `unknown`. Endpoint: the private host if present, else the host.
   - Region: the slug uppercased.
   - Environment and deployment node status:
     - `active` if any child is running or healthy
     - `standby` for the non-active production slot when its droplets exist but are off (for real mode just use `inactive` when nothing runs)
     - otherwise `inactive`
   - Cache the inventory in-process for 30 s, keyed by token. `?refresh=1` bypasses the cache.
   - Errors (`ConnectFailed` reasons): `source: "digitalocean"` with `error` set to the sanitized reason and `tree: []`. The endpoint still returns 200.
3. **Demo fixture** (`dashboard/demo.py`), mirroring the mockup with ServerSherpa names:
   - **Production:** active, Blue active.
     - Blue: v2.8.0, healthy, instances 3/3, traffic 100.
     - Green: standby, v2.7.9, instances 0/3, traffic 0.
     - Load balancer sub: "Blue active".
   - **Dev:** empty, last release `v2.8.1-dev`.
   - **Beta:** empty, last release `v2.8.1-rc.2`.
   - **Health:** healthy, "All systems healthy".
   - **Tree:** Production (Active) contains:
     - Blue (Deployment, Active) with `prod-blue-api` (10.20.0.10), `prod-blue-portal` (10.20.0.11), `prod-blue-kiosk` (10.20.0.12) and `prod-blue-wiki` (10.20.0.13), all Running.
     - Green (Deployment, Standby) with the matching `prod-green-*` droplets (.20–.23), all Standby.
     - Shared production resources (Healthy, badge "Blue + Green") with `prod-db` (Managed PostgreSQL, Healthy, `prod-db.internal`) and `prod-spaces` (Spaces, Available, `prod-assets`).
   - **Development** (Inactive): `dev-web` Droplet Stopped, `dev-db` Available `dev-db.internal`, `dev-spaces` Available `dev-assets`.
   - **Beta** (Inactive): `beta-web` Stopped, `beta-db` Available `beta-db.internal`, `beta-spaces` Available `beta-assets`.
   - Region NYC3 everywhere.
4. **Tests:**
   - Real mode with no token: shape, empty states, `source: "none"`.
   - Inventory grouping with `httpx.MockTransport` fixtures: tagged prod blue/green droplets, shared db, dev/beta resources, a custom env, untagged items, and pagination.
   - Status mappings.
   - Cache, and refresh bypassing it.
   - DO 401 → 200 with `infrastructure.error`.
   - Demo fixture shape.
   - Permission: every role has `dashboard:view`; unauthenticated → 401.
   - Token never in the response.

### Task B: Web — Dashboard page matching the mockup

**Files:**
- Replace `sirdar/web/src/pages/Dashboard.tsx` (it may become a thin wrapper).
- Create under `sirdar/web/src/pages/dashboard/`:
  - `DashboardPage.tsx`
  - `ProductionFlow.tsx` (SVG + GSAP)
  - `EnvCard.tsx`
  - `InfraTree.tsx`
  - `icons.tsx` (inline SVG icons)
  - `dashboard.css` (scoped `.sd-dash`)
- Modify: `lib/sirdarApi.ts` (types + `getDashboard({demo, refresh})`)
- Tests: `pages/dashboard/*.test.tsx`

**Visual spec.** This describes the mockup in detail; match it closely.
- **Overall:**
  - The light page background stays the portal's.
  - The content is a column of white cards: `#fff`, 1px border `#e3e8ef`, radius 8px, subtle shadow `0 1px 2px rgba(16,24,40,.04)`, 24px padding, and 16px gap between cards.
  - Font: the portal font (Geologica).
  - Titles: dark navy `#0f1b2d`.
  - Body text: `#475467`.
  - Accent blue: `#1570ef`, with hover `#175cd3`.
  - Green: `#12b76a`, with a soft bg `#ecfdf3` and text `#027a48`.
  - Gray dot: `#98a2b3`.
  - Support the portal dark theme by defining these as CSS variables on `.sd-dash` with overrides under `.portal-shell[data-theme="dark"] .sd-dash`. Use the dark surfaces `#111827`/`#1f2937`, borders `#374151` and text `#e5e7eb`.
- **Header row** (not in a card):
  - Left: H1 "Deployments" (about 32px, 700), with the subtitle under it: "Independent environments. Blue/Green routing for production."
  - Right: a status pill made of a green dot and "All systems healthy". It follows the `health` label; the dot is gray when unknown and amber when degraded.
  - Then a primary blue button with a rocket icon, "Deploy release". It is **disabled**, with the title "Coming in step 2".
  - Also on the right: a small "Demo data" Switch (portal Switch component) that toggles demo mode (`?demo=1` in the URL, so a refresh keeps it).
  - When demo is on, show a subtle info strip under the header: "Showing demo data — nothing here is real."
- **Production card** (full width):
  - Header: H2 "Production" with a pill. When active: green outline, soft green bg, green dot, "Deployment active". Otherwise: gray, "No active deployment".
  - Body: a horizontal flow diagram, about 220–240px tall.
    - **Left node box:** about 230×90, white, 1px border, radius 6. A large blue cloud icon on the left; bold "Live traffic" above gray "External users".
    - **Middle node box:** a blue load-balancer icon (a node with three branches); bold "Load balancer"; blue "Blue active" (the `load_balancer.sub`, gray when "Not configured").
    - **Right column:** two stacked slot cards, each about 490×105.
      - **Active slot card:** 2px blue border (`#1570ef`) and a slightly stronger shadow. It contains:
        - a server-rack icon with a status dot overlay (blue when active, gray otherwise);
        - bold "Production Blue";
        - an outlined pill "ACTIVE" in blue (uppercase, small);
        - "v2.8.0";
        - a status line with a green dot and "Healthy";
        - a vertical divider, then "3 / 3 instances" and a blue bold "100% traffic".
      - **Standby slot card:** 1px gray border. The pill is "STANDBY" in gray, with a gray dot and "Standby", "0 / 3 instances", gray "0% traffic", and an outlined button "Activate Green" that is disabled with the title "Coming in step 2".
      - **Empty slot:** both slots show "Not deployed" in gray and the button is hidden.
  - **Connectors** (SVG drawn behind and between the boxes):
    - Live traffic → load balancer: a straight horizontal blue line with an arrowhead.
    - Load balancer → active slot: a smooth S-curve, blue, ending in an arrowhead at the active slot.
    - Load balancer → standby slot: a dashed gray S-curve with an arrowhead.
    - The active path carries glowing blue dots: small circles with a soft blue blur, `filter: drop-shadow(0 0 6px rgba(21,112,239,.8))`.
      - Animate them with GSAP so they travel along the path continuously from left to right, staggered, about 2.5 s per trip. MotionPathPlugin is fine.
      - Use about 6 dots on the first segment and 6 on the curve.
    - When production is inactive, draw both curves dashed gray with no moving dots.
    - Respect `prefers-reduced-motion` and the portal motion preference: `.portal-shell[data-motion="off"]` means static dots and no animation.
    - Kill GSAP timelines on unmount.
    - Recompute the paths on resize (`ResizeObserver`), since the layout is responsive.
- **Environments row:** a grid with 2 columns at ≥1100px (1 below), one card per environment (Development, Beta, then custom environments).
  - Each card shows:
    - H3 label;
    - a server-rack icon with a gray dot (blue when active);
    - the uppercase gray "NO ACTIVE DEPLOYMENT", or, when active, the version and a "Running" pill;
    - "Last release: v2.8.1-dev", or "No releases yet";
    - a vertical divider;
    - on the right, a wide outlined button "Deploy to Dev" (`action_label`), disabled, titled "Coming in step 2".
- **Infrastructure card:**
  - Header: H2 "Infrastructure" with the subtitle "Droplet instances and shared resources" (when the source is none: "Connect DigitalOcean on the Deploy page to see your droplets and resources."; on error: an inline error line with the reason).
  - Header right: outlined buttons "↑ Expand all", "＋ Collapse all" and "⟳ Refresh". Refresh calls with `refresh=1` and spins its icon while loading.
  - The table (use the portal `DataTable` if it can render tree rows cleanly; otherwise a semantic `role="treegrid"` built from divs; no raw `<table>`) has columns Instance / resource (wide), Type, Status, Region, Endpoint.
  - Header row in small gray text; light row borders `#eef2f6`; compact rows of about 22–24px; zebra striping is not needed.
  - **Tree column:**
    - Indent 24px per level with dotted vertical guide lines (`border-left: 1px dotted #d0d5dd`).
    - A chevron toggle for nodes with children; the chevron rotates when collapsed.
    - Icons by kind:

      | Kind | Icon |
      |---|---|
      | environment / deployment / group | blue folder; the shared group gets a green folder |
      | droplet | blue droplet (filled when running, outline otherwise) |
      | database | stacked cylinders |
      | spaces | bucket |
      | load balancer | branch icon |

    - Name: bold for env/deployment/group, regular for leaves.
    - Optional status dot after the name: green when active, gray when inactive, blue for droplets.
    - Optional badge pill: blue outline, small, e.g. "Blue + Green".
  - **Status column:** a pill with a dot.
    - Green dot plus soft green bg for active, running, healthy and available.
    - Gray dot plus soft gray bg (`#f2f4f7` / `#667085`) for standby, inactive, stopped and unknown.
    - Amber for provisioning.
  - **Endpoint:** "—" when none.
  - Everything starts expanded. Expand all and Collapse all affect every node. Keyboard: arrow keys move between rows; Left and Right collapse and expand.
- **Loading state:** skeleton shimmer blocks. **Error state:** an inline alert with Retry.

**Behavior and tests:**
- Fetch on mount. The demo toggle refetches. Refresh refetches with `refresh=1`.
- Disabled buttons expose `aria-disabled` and their title.
- Tests (jsdom; GSAP mocked or `gsap.matchMedia` guarded — make animation code tolerate jsdom):
  - Header and health pill from data.
  - Production active vs inactive rendering: pills, the slot cards, the standby button disabled.
  - Environment cards, including a custom one.
  - Infrastructure tree: render, collapse and expand of a node, Expand all and Collapse all, status pill classes, the empty and error states.
  - Demo toggle sets `?demo=1` and calls the API with `demo`.
  - The reduced-motion path skips the animation.
- **Visual check:** `npm run build` must pass. The controller will compare it against the mockup in a live check.

### Task C: Live verification (controller)
1. Run from the worktree (temp `-wt` launch entries).
2. Sign in and open the Dashboard with Demo on.
3. Take screenshots and compare them with the mockup:
   - production flow, with the animated dots moving;
   - the env cards;
   - the tree, including expand and collapse.
4. With Demo off, the empty states render.
5. Check the dark theme quickly.
6. Fix the visual gaps you find with a follow-up subagent.
