# Sirdar dashboard — environment spotlight (design)

Status: approved by Jimmy 2026-10-06. Replaces phase 7b Task 10 (production-only
dashboard) and reshapes Task 5's `GET /dashboard` response. Builds on
`2026-10-05-sirdar-digitalocean-environments-design.md` §7.

## Goal

The top of the Deployments page shows **any** environment, not only production:
a spotlight with an animated flow (live traffic → middle box → server A /
server B). Production becomes a card in the environment grid, and clicking a
card changes the spotlight.

## Decisions (Jimmy, 2026-10-06)

| Topic | Decision |
|---|---|
| "Live traffic" | The live path only: animated dots along the path traffic takes now. No request metrics (a later option for DigitalOcean). |
| Environments without a load balancer | Same shape with the real parts: traffic → Nginx Proxy Manager → the one server. |
| Actions | In the spotlight (Activate, Deploy, Open). Cards select on click and keep a small Deploy button. |

## 1. Layout

1. Header — unchanged (title, health pill, Deploy release, Demo data switch).
2. **Spotlight** — the selected environment:
   - title row: name, type (Production / Development / UAT / Custom), state pill,
     certificate pill (DigitalOcean only; amber at ≤ 14 days, red when expired),
     **Deploy** and **Open** buttons;
   - the flow: **Live traffic** → **middle box** → **server box(es)**.
3. **Environment cards** — Production always first. With no production
   environment the Production card reads "Not built yet" with **Set up**
   (opens the Deploy page). Clicking a card (or Enter/Space on it) selects it;
   the selected card has a highlight ring and `aria-pressed="true"`. Each card
   keeps a small **Deploy** button that does not change the selection.
4. Infrastructure tree — unchanged.

## 2. The flow, per environment

| Environment | Middle box | Servers |
|---|---|---|
| DigitalOcean, two slots | Load balancer (IP, status) | Blue + Green (production) or Orange + Purple |
| DigitalOcean, one slot | Load balancer | Orange |
| LAN (SSH target or VM) | Nginx Proxy Manager (its host) | One box: the host or VM |
| Placeholder (nothing built) | Muted, "Not built yet" | One muted box |

Server box: label, version (short commit or tag), health dot, and **Live** /
**Idle** / **Deploying** / **Failed**.

- Dots run from Live traffic through the middle box to the **live** server only;
  the idle server and its connector are dimmed.
- While a deployment runs, its target server pulses (blue).
- A failed deployment marks its target server red; on a two-slot environment
  the live server stays lit and the title row says "Failed — <Live slot> still
  live".
- Motion off (portal motion preference, `data-motion="off"`, or
  `prefers-reduced-motion`) leaves the dots static. Switching environments
  re-measures the connectors and restarts the animation.

## 3. Actions

- **Activate <Slot>** on the idle server box of a two-slot DigitalOcean
  environment, shown when the user has `deploy:change` and the idle slot has
  run a deploy (`slot_not_deployed` otherwise, so the button is hidden). It
  opens `ActivateModal` (7b Task 9); production asks for the typed name.
- **Deploy** opens the existing `DeployModal`; **Open** goes to
  `/deploy/environments/<name>`.
- Demo data: every action is inert (`aria-disabled`), as today.

## 4. Selection

- Default: the production environment if one exists, else the first card.
- `?env=<name>` in the URL selects that environment (and is updated on click,
  `replace` history), so a link can point at one.
- Otherwise the last pick is remembered per viewer in `localStorage`
  (`sirdar.dashboard.env`, wrapped in try/catch); an unknown remembered name
  falls back to the default.

## 5. Data (`GET /dashboard`)

The separate `production` block goes away. Every card — production included —
has the same shape:

```ts
interface DashEnvironment {
  id: string; label: string; sub: string | null;          // as today
  state: 'active' | 'deploying' | 'failed' | 'empty' | string;
  version: string | null; last_release: string | null; last_release_at: string | null;
  action_label: string; environment: string | null;       // as today
  production: boolean;
  flow: DashFlow;
}
interface DashFlow {
  kind: 'load_balancer' | 'proxy' | 'none';
  middle: { label: string; sub: string; status: 'ok' | 'warn' | 'down' | 'unknown' };
  servers: DashServer[];                                   // 1 or 2
  active_slot: string | null;
  certificate: { days_left: number; expires_at: string; tone: 'ok' | 'warn' | 'bad' } | null;
  deploying_slot: string | null;
  failed_slot: string | null;
}
interface DashServer {
  id: string;            // slot name, or "host" on the LAN
  label: string;         // "Blue", "Orange", or the host / VM name
  sub: string;           // droplet IP / host address
  state: 'live' | 'idle' | 'empty';
  health: 'healthy' | 'degraded' | 'unknown';
  version: string | null;
  deployed: boolean;     // the slot has run a deploy (Activate allowed)
}
```

- The production card is first; with no production environment it is a
  placeholder (`environment: null`, `flow.kind: 'none'`).
- DigitalOcean values come from Sirdar's own records (`do_environments`,
  `do_slots`, `do_resources`) plus the account inventory already fetched for
  the infrastructure tree (load balancer status, droplet status). LAN values
  come from the environment's target (SSH target host or VM address) and the
  publish integration (NPM host).
- `health.status` rolls up over all cards, as today.
- Demo data returns the same shape (a two-slot production, a two-slot dev, a
  LAN uat).

## 6. Components (web)

- `EnvironmentFlow` — generalizes `ProductionFlow` to a `DashFlow` (one or two
  servers, middle-box kind); keeps the measured SVG connectors and GSAP dots.
- `Spotlight` — title row + `EnvironmentFlow` + actions.
- `EnvCard` — gains `selected`, `onSelect`; Production card styling.
- `DashboardPage` — selection state (URL / localStorage / default).

## 7. Testing

- API: `test_dashboard_api.py` / a new `test_dashboard_flow.py` — the card
  shape for production (two slots), a one-slot DigitalOcean environment, a LAN
  SSH environment, a VM environment, a placeholder; certificate tones at 30 /
  14 / 0 days; deploying and failed slots; demo shape.
- Web: selection default, `?env=`, remembered pick and fallback; clicking a card
  changes the spotlight; card Deploy doesn't change selection; one- and
  two-server flows; dots only on the live path; Activate shown only for a
  deployed idle slot with `deploy:change`; demo inert; motion off static.

## Out of scope

- Request metrics on the flow (DigitalOcean load balancer metrics) — later.
- Changing the infrastructure tree.
