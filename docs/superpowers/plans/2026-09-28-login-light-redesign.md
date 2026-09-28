# Portal Login Light Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the portal `/login` page to match Jimmy's light mockup (topo canvas, static route map, headline and features bottom-left, form floating over mountains and clouds) with the real ServerSherpa logo.

**Architecture:** A new static `LoginScene` component (plain markup + inline SVG, no effects) draws everything except the form. `Login.tsx` keeps all sign-in/2FA logic and swaps its markup to `<LoginScene />` plus the form in a right-hand column. A new portal-only stylesheet, `login-light.css`, re-points the shared `auth-theme.css` color tokens so the existing form and 2FA rules come out light, and adds the scene/layout rules. The portal-only map layout is then deleted from `brandScene.ts` and `auth-theme.css`; the kiosk keeps its classic scene unchanged.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library (jsdom), plain CSS.

**Spec:** `docs/superpowers/specs/2026-09-28-login-light-redesign-design.md`

## Global Constraints

- American English in all copy, comments and docs (color, gray, center).
- Portal `/login` only. The kiosk login's look, `kiosk/src/**` files, and the kiosk tests stay unchanged.
- Palette (exact): `--lx-ink #0F172A`, `--lx-orange #FF6A00`, `--lx-canvas #FFF9F2`, `--lx-slate #64748B`, `--lx-line #CBD5E1`, `--lx-field #F8FAFC`, `--lx-ok #22C55E`.
- Fonts stay Geologica (`var(--font-display)`) and Fragment Mono (`var(--font-mono)`); no new font loads. Fragment Mono has only weight 400 — never set a heavier weight on mono text.
- The real logo: `<img src="/images/serversherpa-logo.png" alt="ServerSherpa logo">`.
- The page is completely still: no GSAP or CSS animation in the scene. The only motion kept is the existing failed-sign-in shake (`shakeForm`).
- Every selector in `portal/src/styles/login-light.css` starts with `.login-shell.login-light` (so it outranks `auth-theme.css` regardless of stylesheet order).
- Typography guardrail (`portal/src/styles/listTypography.test.ts`): a CSS rule that sets `font-size`/`font-family`/`font-weight`/`line-height`/`min-height`/`font` must not have a selector matching `/(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head|\b(?:tr|td|th|thead|tbody)\b)/i` — note `arrow` and `narrow` contain `row`, `headline` contains `head`. No `style={{ fontSize … }}`-style inline typography in `.tsx`. Do not add allowlist entries for new rules; pick class names that don't trip the regex.
- Tab order on the sign-in form stays: email → password → Sign in → Continue with SSO → Contact support. "Forgot password?" and the eye toggle keep `tabIndex={-1}`.
- Wording: "SERVERSHERPA PORTAL" eyebrow, "Sign in", "Use the account credentials provided by your migration coordination team.", "Forgot password?", "Sign in", "OR", "Continue with SSO", "Trouble signing in? Contact support". The SSO hint stays "Company SSO isn't enabled yet — sign in with your email and password."
- Node modules in the worktree are symlinks to the main checkout. Never run `npm install`/`npm ci` in the worktree.
- Commit messages end with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Commands (run from the worktree root `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/login-light`):
- Portal tests: `cd portal && npx vitest run <paths>`
- Portal type check: `cd portal && npx tsc -b`
- Kiosk tests: `cd kiosk && npx vitest run`; kiosk type check: `cd kiosk && npx tsc -b`

The art file `portal/public/images/login-mountains-light.webp` (1022×611) is already committed with this plan.

---

### Task 1: LoginScene component, icons and scene styles

**Files:**
- Create: `portal/src/components/login/loginIcons.tsx`
- Create: `portal/src/components/login/LoginScene.tsx`
- Create: `portal/src/styles/login-light.css`
- Test: `portal/src/components/login/LoginScene.test.tsx`

**Interfaces:**
- Produces: `export default function LoginScene(): JSX.Element` (no props) from `portal/src/components/login/LoginScene.tsx`.
- Produces: named exports `IconBox`, `IconBarChart`, `IconShield`, `IconTarget`, `IconEye`, `IconEyeOff`, `IconLink`, `IconArrow` from `portal/src/components/login/loginIcons.tsx`, each `(props: { className?: string }) => JSX.Element` rendering an `aria-hidden="true"` 24×24 stroke SVG.
- Produces: `portal/src/styles/login-light.css` with the root rule and scene rules. Task 2 imports it from `Login.tsx` and appends the form/responsive rules.
- CSS class names Task 2 relies on: root `.login-light` (used together with `.login-shell`), scene classes `.lx-topo`, `.lx-mountains`, `.lx-logo`, `.lx-map`, `.lx-card`, `.lx-state`, `.lx-pin-meta`, `.lx-leader`, `.lx-story`, `.lx-status`.

- [ ] **Step 1: Write the failing test**

Create `portal/src/components/login/LoginScene.test.tsx`:

```tsx
// @vitest-environment jsdom
/** The static scene behind the portal sign-in form: real logo, the
 *  Dallas → Las Vegas route map, headline, features and status line. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import LoginScene from './LoginScene';

afterEach(cleanup);

it('shows the real logo, name and tagline', () => {
  render(<LoginScene />);
  const logo = screen.getByAltText('ServerSherpa logo') as HTMLImageElement;
  expect(logo.getAttribute('src')).toBe('/images/serversherpa-logo.png');
  expect(screen.getByText('Datacenter Relocation Tools')).toBeTruthy();
});

it('draws both pins, the route, the Route 07 card and four state names inside a hidden map', () => {
  const { container } = render(<LoginScene />);
  const map = container.querySelector('.lx-map');
  if (!map) throw new Error('no .lx-map');
  expect(map.getAttribute('aria-hidden')).toBe('true');
  const text = map.textContent ?? '';
  for (const s of [
    'ORIGIN · DAL-7', 'Dallas, TX · HALL B', '32.7767° N / 96.7970° W', "ELEV. 438'",
    'DESTINATION · LAS-9', 'Las Vegas, NV · HALL D', '36.1696° N / 115.1398° W', "ELEV. 2,061'",
    'ROUTE 07', '1,241 ASSETS', 'RACK 83 · ETA 2h 14m',
  ]) expect(text).toContain(s);
  expect([...map.querySelectorAll('.lx-state')].map((n) => n.textContent))
    .toEqual(['NEVADA', 'CALIFORNIA', 'ARIZONA', 'TEXAS']);
  expect(map.querySelector('.lx-route')).not.toBeNull();
  expect(map.querySelectorAll('.lx-pin')).toHaveLength(2);
});

it('keeps the headline, description, features and status as readable text', () => {
  render(<LoginScene />);
  expect(screen.getByRole('heading', { level: 1 }).textContent)
    .toBe('Migration Control. From First Scan to Final Rack.');
  expect(screen.getByText(/Track relocation progress, review manifests, verify assets/)).toBeTruthy();
  expect(screen.getAllByRole('listitem').map((li) => li.textContent))
    .toEqual(['Track assets', 'Monitor progress', 'Verify work', 'Complete on time']);
  const status = screen.getByText('ALL SYSTEMS OPERATIONAL');
  expect(status.closest('.lx-status')?.textContent).toContain('STATUS.SERVERSHERPA.COM');
});

it('hides the decorative layers from screen readers and uses the light art', () => {
  const { container } = render(<LoginScene />);
  for (const sel of ['.lx-topo', '.lx-mountains', '.lx-map']) {
    expect(container.querySelector(sel)?.getAttribute('aria-hidden')).toBe('true');
  }
  container.querySelectorAll('.lx-features svg').forEach((svg) => {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
  expect(container.querySelector('.lx-mountains')?.getAttribute('src'))
    .toBe('/images/login-mountains-light.webp');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd portal && npx vitest run src/components/login/LoginScene.test.tsx`
Expected: FAIL — cannot resolve `./LoginScene`.

- [ ] **Step 3: Write the icons**

Create `portal/src/components/login/loginIcons.tsx`:

```tsx
/**
 * Line icons from the login element sheet (2026-09-28). Decorative only:
 * every icon is aria-hidden, so the control or text beside it carries the
 * accessible name. Stroke uses currentColor; size comes from CSS.
 */
import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Icon({ className, strokeWidth = 1.8, children }: IconProps & { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconBox({ className }: IconProps) {
  return <Icon className={className}><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7L12 2.5Z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></Icon>;
}

export function IconBarChart({ className }: IconProps) {
  return <Icon className={className}><path d="M3 21h18" /><path d="M6 21v-6M10 21V9M14 21V4M18 21v-9" /></Icon>;
}

export function IconShield({ className }: IconProps) {
  return <Icon className={className}><path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10v-6L12 2.5Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Icon>;
}

export function IconTarget({ className }: IconProps) {
  return <Icon className={className}><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="5.5" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></Icon>;
}

export function IconEye({ className }: IconProps) {
  return <Icon className={className}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function IconEyeOff({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

export function IconLink({ className }: IconProps) {
  return <Icon className={className} strokeWidth={2}><circle cx="17" cy="7" r="3.5" /><circle cx="7" cy="17" r="3.5" /><path d="m9.5 14.5 5-5" /></Icon>;
}

export function IconArrow({ className }: IconProps) {
  return <Icon className={className} strokeWidth={2.2}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
}
```

- [ ] **Step 4: Write the scene**

Create `portal/src/components/login/LoginScene.tsx`:

```tsx
/**
 * LoginScene — everything on the portal sign-in page except the form: faint
 * topo lines, the real logo, the static Dallas → Las Vegas route map, the
 * headline and feature row, the status line and the mountain art (light
 * mockup, 2026-09-28). Pure markup, no effects. Map positions are the
 * mockup's pixel positions inside a 1040×560 map box, set as percentages so
 * the map scales as one piece (login-light.css sizes the box and scales its
 * text with container units).
 */
import type { CSSProperties } from 'react';

import { IconBarChart, IconBox, IconShield, IconTarget } from './loginIcons';

const MAP_W = 1040;
const MAP_H = 560;
const at = (x: number, y: number): CSSProperties => ({
  left: `${(x / MAP_W) * 100}%`,
  top: `${(y / MAP_H) * 100}%`,
});

const STATES = [
  { name: 'NEVADA', x: 576, y: 138 },
  { name: 'CALIFORNIA', x: 138, y: 319 },
  { name: 'ARIZONA', x: 813, y: 403 },
  { name: 'TEXAS', x: 183, y: 509 },
];

const PINS = [
  { key: 'destination', x: 790, y: 95, title: 'DESTINATION · LAS-9', place: 'Las Vegas, NV · HALL D',
    coords: '36.1696° N / 115.1398° W', elev: "ELEV. 2,061'" },
  { key: 'origin', x: 358, y: 458, title: 'ORIGIN · DAL-7', place: 'Dallas, TX · HALL B',
    coords: '32.7767° N / 96.7970° W', elev: "ELEV. 438'" },
];

const ROUTE_D = 'M373 421 C 392 330 440 244 573 213 C 670 190 745 160 776 112';

const FEATURES = [
  { label: 'Track assets', Icon: IconBox },
  { label: 'Monitor progress', Icon: IconBarChart },
  { label: 'Verify work', Icon: IconShield },
  { label: 'Complete on time', Icon: IconTarget },
];

/* Faint contour lines in a fixed 1672×941 frame that covers the page
   (slice), drawn in code so they stay sharp at any size. Deterministic. */
function contour(i: number): string {
  const base = -30 + i * 64;
  let d = '';
  for (let x = -40; x <= 1720; x += 24) {
    const y = base + 26 * Math.sin(x / 230 + i * 0.8) + 11 * Math.sin(x / 91 + i * 1.9);
    d += `${d ? ' L' : 'M'}${x} ${y.toFixed(1)}`;
  }
  return d;
}
const CONTOURS = Array.from({ length: 17 }, (_, i) => contour(i));

export default function LoginScene() {
  return (
    <>
      <svg className="lx-topo" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {CONTOURS.map((d, i) => <path key={i} d={d} />)}
      </svg>

      <img className="lx-mountains" src="/images/login-mountains-light.webp" alt="" aria-hidden="true" />

      <header className="lx-logo">
        <img
          className="lx-logo-mark"
          src="/images/serversherpa-logo.png"
          alt="ServerSherpa logo"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div>
          <div className="lx-logo-name">Server<em>Sherpa</em></div>
          <div className="lx-logo-tag">Datacenter Relocation Tools</div>
        </div>
      </header>

      <div className="lx-map" aria-hidden="true">
        <svg className="lx-map-art" viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
          <path className="lx-leader" d="M432 242 H 470" />
          <path className="lx-route" d={ROUTE_D} />
          <circle className="lx-glow-halo" cx="573" cy="213" r="16" />
          <circle className="lx-glow-dot" cx="573" cy="213" r="6.5" />
          <circle className="lx-glow-halo" cx="373" cy="421" r="11" />
          <circle className="lx-glow-dot" cx="373" cy="421" r="4.5" />
          {PINS.map((p) => (
            <g key={p.key} className="lx-pin" transform={`translate(${p.x} ${p.y})`}>
              <circle className="lx-pin-ring" r="19" />
              <circle className="lx-pin-ring" r="11" />
              <circle className="lx-pin-core" r="4.5" />
            </g>
          ))}
        </svg>
        {STATES.map((s) => (
          <span key={s.name} className="lx-state" style={at(s.x, s.y)}>{s.name}</span>
        ))}
        {PINS.map((p) => (
          <div key={p.key} className="lx-pin-label" style={at(p.x + 36, p.y - 19)}>
            <span className="lx-pin-title">{p.title}</span>
            <span>{p.place}</span>
            <span className="lx-pin-meta">{p.coords}</span>
            <span className="lx-pin-meta">{p.elev}</span>
          </div>
        ))}
        <div className="lx-card" style={at(240, 205)}>
          <b>ROUTE 07</b>
          <span>1,241 ASSETS</span>
          <span>RACK 83 · ETA 2h 14m</span>
        </div>
      </div>

      <div className="lx-story">
        <h1 className="lx-hero">
          <span>Migration Control.</span>{' '}
          <span className="accent">From First Scan to Final Rack.</span>
        </h1>
        <p className="lx-sub">
          Track relocation progress, review manifests, verify assets,
          and access complete migration records.
        </p>
        <ul className="lx-features">
          {FEATURES.map(({ label, Icon }) => (
            <li key={label}>
              <Icon />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className="lx-status">
        <span className="lx-status-dot" />
        <b>ALL SYSTEMS OPERATIONAL</b>
        <span className="lx-status-sep">|</span>
        <span>STATUS.SERVERSHERPA.COM</span>
      </footer>
    </>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd portal && npx vitest run src/components/login/LoginScene.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the scene styles**

Create `portal/src/styles/login-light.css`:

```css
/* ============================================================
   login-light.css — the portal sign-in page (light mockup, 2026-09-28).
   Every rule is scoped to .login-shell.login-light: it outranks the
   shared auth-theme.css (also used by the kiosk login, which must not
   change) whatever order the two sheets load in. The auth-theme color
   tokens are re-pointed here so its form and 2FA rules come out light;
   only sizes and a few details are overridden below.
   ============================================================ */
.login-shell.login-light {
  --lx-ink: #0F172A; --lx-orange: #FF6A00; --lx-canvas: #FFF9F2; --lx-slate: #64748B;
  --lx-line: #CBD5E1; --lx-field: #F8FAFC; --lx-ok: #22C55E;
  --ink: #0F172A; --amber: #FF6A00; --amber-soft: #FF8A3D; --paper: #FFF9F2; --paper-2: #FFF9F2;
  --paper-line: #CBD5E1; --text-dark: #0F172A; --text-mute: #64748B; --snow: #F8FAFC; --ok: #22C55E;
  display: block; position: relative; height: auto; min-height: max(100dvh, 700px);
  overflow-x: clip; overflow-y: visible;
  background: var(--lx-canvas); color: var(--lx-ink);
}

/* ---------- background layers ---------- */
.login-shell.login-light .lx-topo { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
  fill: none; stroke: var(--lx-orange); stroke-width: 1; opacity: .14 }
.login-shell.login-light .lx-topo path { vector-effect: non-scaling-stroke }
/* cropped from the mockup (the mockup's form was inpainted out, leaving mist
   where our form sits); top and left edges fade into the canvas */
.login-shell.login-light .lx-mountains { position: absolute; right: 0; bottom: 0; width: 61.1%; height: auto;
  pointer-events: none; user-select: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26%), linear-gradient(to right, transparent 0, #000 16%);
  -webkit-mask-composite: source-in;
  mask-image: linear-gradient(to bottom, transparent 0, #000 26%), linear-gradient(to right, transparent 0, #000 16%);
  mask-composite: intersect }

/* ---------- logo ---------- */
.login-shell.login-light .lx-logo { position: absolute; z-index: 2; left: clamp(16px, 2.1vw, 40px); top: clamp(16px, 4.2vh, 44px);
  display: flex; align-items: center; gap: 18px }
.login-shell.login-light .lx-logo-mark { width: clamp(52px, 4.4vw, 74px); height: auto; flex: none; object-fit: contain }
.login-shell.login-light .lx-logo-name { font-weight: 800; font-size: clamp(22px, 1.9vw, 32px); letter-spacing: -.01em; line-height: 1; color: var(--lx-ink) }
.login-shell.login-light .lx-logo-name em { font-style: normal; color: var(--lx-orange) }
.login-shell.login-light .lx-logo-tag { margin-top: 10px; font-family: var(--font-mono); font-size: clamp(10px, .8vw, 13px);
  letter-spacing: .3em; text-transform: uppercase; color: var(--lx-slate) }

/* ---------- route map ----------
   A 1040×560 box (the mockup's map area) that scales as one piece: never
   wider than 62.2% of the page, than fits above the headline, or than
   leaves clear of the form column. Text sizes use container units. */
.login-shell.login-light .lx-map { position: absolute; z-index: 1; left: 0; top: 0; pointer-events: none;
  container-type: inline-size; aspect-ratio: 1040 / 560;
  width: min(62.2%, 1040px, calc((100dvh - 380px) * 1.857), calc((100% - 418px - 5.4% - 48px) * 1.03)) }
.login-shell.login-light .lx-map-art { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible }
.login-shell.login-light .lx-route { fill: none; stroke: var(--lx-orange); stroke-width: 2.6; stroke-dasharray: 8 7; stroke-linecap: round }
.login-shell.login-light .lx-leader { fill: none; stroke: var(--lx-orange); stroke-width: 1.2; opacity: .7 }
.login-shell.login-light .lx-pin { filter: drop-shadow(0 0 6px rgba(255, 106, 0, .45)) }
.login-shell.login-light .lx-pin-ring { fill: #fff; stroke: var(--lx-orange); stroke-width: 3.5 }
.login-shell.login-light .lx-pin-core { fill: var(--lx-orange) }
.login-shell.login-light .lx-glow-halo { fill: rgba(255, 106, 0, .18) }
.login-shell.login-light .lx-glow-dot { fill: var(--lx-orange); stroke: #fff; stroke-width: 2.5; filter: drop-shadow(0 0 7px rgba(255, 106, 0, .9)) }
.login-shell.login-light .lx-state,
.login-shell.login-light .lx-pin-label,
.login-shell.login-light .lx-card { position: absolute; font-family: var(--font-mono); white-space: nowrap }
.login-shell.login-light .lx-state { transform: translate(-50%, -50%); font-size: clamp(9px, 1.3cqi, 14px); letter-spacing: .3em; color: var(--lx-slate) }
.login-shell.login-light .lx-pin-label { display: flex; flex-direction: column; gap: .35em; font-size: clamp(9px, 1.25cqi, 13.5px); color: #334155 }
.login-shell.login-light .lx-pin-title { font-size: 1.15em; letter-spacing: .08em; color: var(--lx-orange) }
.login-shell.login-light .lx-pin-meta { font-size: .85em; letter-spacing: .04em; color: var(--lx-slate) }
.login-shell.login-light .lx-card { width: 18.5%; padding: 1.1cqi 1.3cqi; display: flex; flex-direction: column;
  background: #fff; border: 1px solid var(--lx-orange); border-radius: 4px; box-shadow: 0 6px 18px -10px rgba(15, 23, 42, .25);
  font-size: clamp(9px, 1.2cqi, 13px); line-height: 1.55; color: #334155 }
.login-shell.login-light .lx-card b { margin-bottom: .3em; font-size: 1.2em; font-weight: 400; letter-spacing: .08em; color: var(--lx-orange) }

/* ---------- headline, description, features ---------- */
.login-shell.login-light .lx-story { position: absolute; z-index: 2; left: clamp(16px, 2.3vw, 44px); bottom: clamp(84px, 11.5vh, 112px);
  max-width: min(640px, calc(100% - 418px - 5.4% - 96px)) }
.login-shell.login-light .lx-hero { margin: 0; display: flex; flex-direction: column; font-size: clamp(28px, 2.9vw, 50px);
  font-weight: 800; line-height: 1.08; letter-spacing: -.02em; color: var(--lx-ink) }
.login-shell.login-light .lx-hero .accent { color: var(--lx-orange) }
.login-shell.login-light .lx-sub { margin: 16px 0 0; max-width: 34em; font-size: clamp(14px, 1.05vw, 17.5px); font-weight: 300;
  line-height: 1.45; color: var(--lx-slate) }
.login-shell.login-light .lx-features { list-style: none; margin: clamp(22px, 3.4vh, 40px) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 14px 0 }
.login-shell.login-light .lx-features li { display: flex; align-items: center; gap: 14px; padding: 0 22px; border-left: 1px solid var(--lx-line);
  font-family: var(--font-mono); font-size: clamp(11px, .8vw, 13px); letter-spacing: .12em; line-height: 1.35; text-transform: uppercase; color: var(--lx-ink) }
.login-shell.login-light .lx-features li:first-child { padding-left: 0; border-left: 0 }
/* two-line labels like the mockup: "Complete on time" breaks after "Complete" */
.login-shell.login-light .lx-features li span { max-width: 7em }
.login-shell.login-light .lx-features svg { width: clamp(26px, 2vw, 34px); height: clamp(26px, 2vw, 34px); flex: none; color: var(--lx-orange) }

/* ---------- status line ---------- */
.login-shell.login-light .lx-status { position: absolute; z-index: 2; left: clamp(16px, 2.3vw, 44px); bottom: clamp(20px, 4vh, 44px);
  display: flex; align-items: center; gap: 14px; font-family: var(--font-mono); font-size: clamp(10.5px, .78vw, 12.5px);
  letter-spacing: .1em; color: var(--lx-slate); white-space: nowrap }
.login-shell.login-light .lx-status::before { content: ""; position: absolute; left: 0; right: 0; top: -22px; height: 1px; background: var(--lx-line) }
.login-shell.login-light .lx-status-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: var(--lx-ok); box-shadow: 0 0 6px rgba(34, 197, 94, .6) }
.login-shell.login-light .lx-status b { font-weight: 400; color: #334155 }
.login-shell.login-light .lx-status-sep { color: var(--lx-line) }
```

- [ ] **Step 7: Run the scene test and the typography guardrail**

Run: `cd portal && npx vitest run src/components/login/LoginScene.test.tsx src/styles/listTypography.test.ts`
Expected: PASS. If the guardrail flags a new selector, rename the class (never allowlist it).

- [ ] **Step 8: Type check**

Run: `cd portal && npx tsc -b`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add portal/src/components/login portal/src/styles/login-light.css
git commit -m "feat(portal): static light login scene, element-sheet icons and scene styles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire the scene into Login.tsx and restyle the form

**Files:**
- Modify: `portal/src/pages/Login.tsx`
- Modify: `portal/src/styles/login-light.css` (append form, 2FA and responsive rules)
- Test: `portal/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes: `LoginScene` (default export, no props) from `../components/login/LoginScene`; `IconArrow`, `IconEye`, `IconEyeOff`, `IconLink` from `../components/login/loginIcons` (each takes an optional `className`); `portal/src/styles/login-light.css` from Task 1 (root rule `.login-shell.login-light`, class names `.lx-card`, `.lx-state`, `.lx-pin-meta`, `.lx-leader`, `.lx-map`, `.lx-story`, `.lx-logo`, `.lx-mountains`, `.lx-status`).
- Produces: the page root `<div className="login-shell login-light">` with `<LoginScene />` then `<main className="lx-form-col">` holding the existing `.form-wrap`.

- [ ] **Step 1: Write the failing tests**

In `portal/src/pages/Login.test.tsx`:

1. Replace the header comment (lines 2–4) with:

```tsx
/** The portal sign-in page: keyboard path (email → Tab → password → Tab →
 *  Sign in; "Forgot password?" and the eye toggle sit between them in the
 *  DOM and must not interrupt it), the light-mockup wording, SSO hint,
 *  support card, and both two-factor steps. */
```

2. Delete this line (Login no longer imports the scene builder):

```tsx
vi.mock('../lib/brandScene', () => ({ buildBrandScene: () => () => {} }));
```

3. Change the matchMedia comment to `// jsdom has no matchMedia; the error shake asks it about reduced motion` (keep the stub itself).

4. Append these tests at the end of the file:

```tsx
it('uses the mockup wording and the light scene with the real logo', () => {
  const { container } = render(<MemoryRouter><Login /></MemoryRouter>);
  expect(container.querySelector('.login-shell.login-light')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Sign in' })).toBeTruthy();
  expect(screen.getByText('Use the account credentials provided by your migration coordination team.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeTruthy();
  expect(screen.getByAltText('ServerSherpa logo').getAttribute('src')).toBe('/images/serversherpa-logo.png');
  // the entrance animation is gone, so nothing is tagged for it
  expect(container.querySelector('[data-reveal]')).toBeNull();
});

it('Continue with SSO explains that SSO is not enabled yet', async () => {
  const user = userEvent.setup();
  renderLogin();
  await user.click(screen.getByRole('button', { name: 'Continue with SSO' }));
  expect(screen.getByText("Company SSO isn't enabled yet — sign in with your email and password.")).toBeTruthy();
});

it('Forgot password? and Contact support both open the support card', async () => {
  const user = userEvent.setup();
  renderLogin();
  await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Got it' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Contact support' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('the eye toggle shows and hides the password', async () => {
  const user = userEvent.setup();
  const { password } = renderLogin();
  expect(password.getAttribute('type')).toBe('password');
  await user.click(screen.getByRole('button', { name: 'Show password' }));
  expect(password.getAttribute('type')).toBe('text');
  await user.click(screen.getByRole('button', { name: 'Hide password' }));
  expect(password.getAttribute('type')).toBe('password');
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd portal && npx vitest run src/pages/Login.test.tsx`
Expected: the four new tests FAIL (no `.login-light`, "Login with SSO"/"Forgot?" wording, `data-reveal` present); the existing eight still PASS.

- [ ] **Step 3: Update Login.tsx**

Make exactly these changes in `portal/src/pages/Login.tsx`:

a. Replace the file header comment (lines 1–9) with:

```tsx
/**
 * Login page — the light ServerSherpa sign-in (mockup approved 2026-09-28):
 * a static scene (LoginScene: topo lines, route map, headline, features,
 * mountain art) with the form floating on the right. Rewired for the V3 API
 * (email login, cookie-based sessions); the form shakes on error unless
 * reduced motion is set.
 *
 * Two-factor verify/enrollment is built in (the code card and EnrollFlow
 * below); only the SSO flow remains deferred (button kept as a hint).
 */
```

b. Imports: delete `import { buildBrandScene } from '../lib/brandScene';`. Add, in the existing import groups:

```tsx
import LoginScene from '../components/login/LoginScene';
import { IconArrow, IconEye, IconEyeOff, IconLink } from '../components/login/loginIcons';
```

and directly after `import '../styles/auth-theme.css';` add:

```tsx
import '../styles/login-light.css';
```

c. Delete the whole `const FEATURES = [ … ];` block (it moved into LoginScene).

d. Delete the two refs and the scene effect:

```tsx
  const brandRef = useRef<HTMLElement>(null);
  const terrainSvgRef = useRef<SVGSVGElement>(null);
```

```tsx
  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!brandRef.current || !terrainSvgRef.current) return;
    return buildBrandScene(brandRef.current, terrainSvgRef.current, reduceMotion, { layout: 'map' });
  }, []);
```

e. Replace everything from `<div className="login-shell login-map">` down to and including `<div className="form-wrap" ref={formWrapRef}>` (the whole brand `<section>` and the opening of the pane section) with:

```tsx
    <div className="login-shell login-light">
      <LoginScene />

      {/* ============ SIGN-IN FORM ============ */}
      <main className="lx-form-col">
        <div className="form-wrap" ref={formWrapRef}>
```

and change the matching closing tag after the form-wrap's `</div>` from `</section>` to `</main>`.

f. Remove every `data-reveal=""` attribute in the file.

g. In the password label, change the link text `Forgot?` to `Forgot password?` (keep `tabIndex={-1}` and its onClick).

h. Replace the eye toggle's inline `<svg …>…</svg>` (inside the `peek` button) with:

```tsx
                      {showPassword ? <IconEyeOff /> : <IconEye />}
```

i. In the Sign in button, replace `<svg className="arrow" …>…</svg>` with:

```tsx
                  <IconArrow className="arrow" />
```

j. Replace the SSO button's lock `<svg …>…</svg>` and its text `Login with SSO` with:

```tsx
                <IconLink />
                Continue with SSO
```

k. Check nothing else still uses `useEffect`/`useRef` wrongly: `useEffect` stays (the `getSystemStatus` effect) and `useRef` stays (`formWrapRef`, `emailRef`, `passwordRef`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd portal && npx vitest run src/pages/Login.test.tsx src/components/login/LoginScene.test.tsx`
Expected: PASS (12 + 4 tests).

- [ ] **Step 5: Append the form, 2FA and responsive styles**

Append to `portal/src/styles/login-light.css`:

```css
/* ---------- form column (no card; floats over the art) ---------- */
.login-shell.login-light .lx-form-col { position: absolute; z-index: 3; top: 0; bottom: 0; right: 5.4%;
  width: min(418px, calc(100% - 32px)); display: flex; align-items: center; padding: clamp(24px, 5vh, 56px) 0 }
/* soft cream wash so the form reads cleanly wherever the art sits behind it */
.login-shell.login-light .lx-form-col::before { content: ""; position: absolute; inset: -8% -14%; z-index: -1; pointer-events: none;
  background: radial-gradient(closest-side, rgba(255, 249, 242, .82), rgba(255, 249, 242, .55) 60%, rgba(255, 249, 242, 0)) }
.login-shell.login-light .form-wrap { max-width: none }
.login-shell.login-light .eyebrow { font-size: clamp(11px, .8vw, 13px); letter-spacing: .32em }
.login-shell.login-light .eyebrow::after { background: var(--lx-orange) }
.login-shell.login-light .form-title { margin: 12px 0 0; font-size: clamp(34px, 2.9vw, 48px); font-weight: 800; letter-spacing: -.025em }
.login-shell.login-light .form-hint { margin: 14px 0 0; font-size: clamp(15px, 1vw, 17px); line-height: 1.45 }
.login-shell.login-light form { margin-top: clamp(24px, 4vh, 40px) }
.login-shell.login-light .field label { font-size: 12px; letter-spacing: .3em }
.login-shell.login-light .field button.link { font-size: 14px; color: var(--lx-ink); border-bottom-color: var(--lx-ink) }
.login-shell.login-light .field button.link:hover { border-bottom-color: var(--lx-orange) }
.login-shell.login-light .control input { background: #fff; border-radius: 8px; padding: 16px 18px; font-size: 16.5px }
.login-shell.login-light .control input::placeholder { color: #94A3B8 }
.login-shell.login-light .control input:focus:not(.invalid) { box-shadow: 0 0 0 3px rgba(255, 106, 0, .14) }

/* primary button: navy with an orange arrow; no sweep, the arrow nudges on hover */
.login-shell.login-light .btn { border-radius: 8px; padding: 18px 20px; font-size: 18px; color: #fff }
.login-shell.login-light .btn:before { display: none }
.login-shell.login-light .btn:hover:not(:disabled) { background: #1E293B }
.login-shell.login-light .btn:hover span { color: #fff }
.login-shell.login-light .btn .arrow,
.login-shell.login-light .btn:hover .arrow { width: 22px; height: 22px; color: var(--lx-orange) }
.login-shell.login-light .btn:disabled:not(.loading) { background: #94A3B8; opacity: 1 }
.login-shell.login-light .btn:disabled:not(.loading) .arrow { color: #E2E8F0 }

.login-shell.login-light .divider { margin: 26px 0; font-size: 12px; letter-spacing: .3em; color: var(--lx-slate) }
.login-shell.login-light .btn-sso { border-width: 1px; border-radius: 8px; padding: 15px; background: rgba(255, 255, 255, .85); font-size: 17px }
.login-shell.login-light .btn-sso:hover { border-color: var(--lx-ink); background: #fff }
.login-shell.login-light .btn-sso svg { width: 22px; height: 22px }
.login-shell.login-light .form-foot { font-size: 15px }
.login-shell.login-light .form-foot button.link { font-size: 15px; border-bottom-color: var(--lx-ink) }

/* two-factor cards: white on the cream page */
.login-shell.login-light .form-wrap .otp-card.inline-card { background: #fff; border: 1px solid var(--lx-line) }
.login-shell.login-light .otp-inputs input,
.login-shell.login-light .code-input input { background: #fff }

/* ---------- 900–1279px: drop the smaller map details ---------- */
@media (max-width: 1279px) {
  .login-shell.login-light .lx-card,
  .login-shell.login-light .lx-state,
  .login-shell.login-light .lx-pin-meta,
  .login-shell.login-light .lx-leader { display: none }
}

/* ---------- under 900px: logo, form, art and status in one column ---------- */
@media (max-width: 899px) {
  .login-shell.login-light { display: flex; flex-direction: column; align-items: center; min-height: 100dvh; padding: 0 16px }
  .login-shell.login-light .lx-map,
  .login-shell.login-light .lx-story { display: none }
  .login-shell.login-light .lx-logo { position: relative; left: auto; top: auto; align-self: flex-start; margin: 20px 0 0 }
  .login-shell.login-light .lx-form-col { position: relative; top: auto; right: auto; bottom: auto; width: 100%; max-width: 418px; flex: 1; padding: 32px 0 }
  .login-shell.login-light .lx-mountains { width: 100% }
  .login-shell.login-light .lx-status { position: relative; left: auto; bottom: auto; align-self: flex-start; margin: 0 0 20px;
    flex-wrap: wrap; white-space: normal }
  .login-shell.login-light .lx-status::before { display: none }
}
```

- [ ] **Step 6: Run the page tests, the guardrail and the type check**

Run: `cd portal && npx vitest run src/pages/Login.test.tsx src/components/login src/styles/listTypography.test.ts && npx tsc -b`
Expected: PASS; `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add portal/src/pages/Login.tsx portal/src/pages/Login.test.tsx portal/src/styles/login-light.css
git commit -m "feat(portal): light sign-in page — LoginScene, mockup wording, light form and 2FA styles

Continue with SSO and Forgot password? wording, element-sheet icons, no
entrance animation; responsive at 1279px and 899px.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Remove the portal-only map layout (scene builder, styles, old art)

**Files:**
- Modify: `portal/src/lib/brandScene.ts`
- Modify: `portal/src/lib/brandScene.test.ts`
- Modify: `portal/src/styles/auth-theme.css`
- Modify: `portal/src/styles/listTypography.allow.json`
- Delete: `portal/public/images/login-mountains.png`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 except that the portal no longer calls `buildBrandScene` (verify with grep in Step 1).
- Produces: `buildBrandScene(brandPanel: HTMLElement, svg: SVGSVGElement, reduceMotion: boolean): () => void` — the `options` parameter and the exported `BrandSceneOptions` type are removed. The only caller is `kiosk/src/pages/Login.tsx:92`, which already passes three arguments.

- [ ] **Step 1: Confirm the portal no longer uses the map layout**

Run:
```bash
grep -rn "buildBrandScene\|BrandSceneOptions\|login-mountains.png\|brand-map\|login-map\|pane-topo" portal/src kiosk/src portal/public 2>/dev/null
```
Expected: matches only in `portal/src/lib/brandScene.ts`, `portal/src/lib/brandScene.test.ts`, `portal/src/styles/auth-theme.css`, `portal/src/styles/listTypography.allow.json`, and `kiosk/src/pages/Login.tsx` (the kiosk's `buildBrandScene` import and call). If `portal/src/pages/Login.tsx` still matches, stop and report BLOCKED.

- [ ] **Step 2: Record the classic scene's markup before the change**

Create a temporary test `portal/src/lib/brandScene.dump.tmp.test.ts`:

```ts
// @vitest-environment jsdom
/* TEMPORARY — dumps the classic scene so Task 3 can prove it is unchanged.
   Deleted in Step 6. */
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';

import { buildBrandScene } from './brandScene';

Object.assign(SVGElement.prototype, {
  getTotalLength: () => 100,
  getPointAtLength: () => ({ x: 0, y: 0 }),
  getBBox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
});

it('dumps the classic scene markup', () => {
  for (const reduce of [true, false]) {
    const brand = document.createElement('section');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    brand.appendChild(svg);
    document.body.appendChild(brand);
    const cleanup = buildBrandScene(brand, svg, reduce);
    writeFileSync(`${process.env.DUMP_DIR}/classic-${reduce}.svg`, svg.outerHTML);
    cleanup();
    brand.remove();
  }
});
```

Run:
```bash
mkdir -p /tmp/login-light-dump/before /tmp/login-light-dump/after
cd portal && DUMP_DIR=/tmp/login-light-dump/before npx vitest run src/lib/brandScene.dump.tmp.test.ts
```
Expected: PASS; two files in `/tmp/login-light-dump/before`.

- [ ] **Step 3: Remove the map layout from brandScene.ts**

In `portal/src/lib/brandScene.ts`:
- Delete the `BrandSceneOptions` interface and the `options: BrandSceneOptions = {}` parameter, and the line `const map = options.layout === 'map';`.
- Everywhere the code branches on `map`, keep only the classic (`map === false`) behavior and delete the map branch: every `if (map) { … }` block, the map arm of every `map ? … : …` ternary, `if (!map)` guards (keep their bodies, drop the condition), `map && …` expressions, the state-name group and its collision/settle logic, the destination-label fit helper if only the map layout uses it, the waypoint and route-callout drawing, the `routeTrip` loop, the `.route-lit`/mask trail, the route marker, and the `mapGroup` drift (`sx`).
- Delete any helper, constant or import that becomes unused (the type check in Step 5 and `noUnusedLocals` will flag them).
- Update the file header comment: the scene is now used only by the kiosk login (`kiosk/src/pages/Login.tsx`); drop "pages/Login.tsx (portal) and".
- Update the comment above `buildBrandScene` accordingly. Do not change anything the classic path does.

- [ ] **Step 4: Prove the classic scene is unchanged**

Run:
```bash
cd portal && DUMP_DIR=/tmp/login-light-dump/after npx vitest run src/lib/brandScene.dump.tmp.test.ts
cmp /tmp/login-light-dump/before/classic-true.svg /tmp/login-light-dump/after/classic-true.svg && cmp /tmp/login-light-dump/before/classic-false.svg /tmp/login-light-dump/after/classic-false.svg && echo IDENTICAL
```
Expected: `IDENTICAL`. If not, the edit changed the classic path — fix it before continuing.

- [ ] **Step 5: Update the scene tests**

In `portal/src/lib/brandScene.test.ts`:
- Update the header comment: "…so the kiosk app can import it without pulling in a React component" stays; nothing mentions the portal map.
- Delete the three tests whose names start with `map layout`.
- Rename `'classic layout (the kiosk default) keeps the original route and no map extras'` to `'the kiosk scene keeps the original route, traveler and no map extras'` and keep its body unchanged.

Run: `cd portal && npx vitest run src/lib/brandScene.test.ts`
Expected: PASS (2 tests). (The type check runs in Step 9, after the temporary dump test is gone.)

- [ ] **Step 6: Delete the temporary dump test**

Run: `rm portal/src/lib/brandScene.dump.tmp.test.ts && rm -rf /tmp/login-light-dump`

- [ ] **Step 7: Remove the map-layout styles and their allowlist entries**

In `portal/src/styles/auth-theme.css`, delete the whole block that starts with the comment

```css
/* ============================================================
   Portal map layout (.brand-map) — Dallas → Las Vegas route over a faint
```

through the end of the `@media(max-width:860px) { /* restate the stacked layout … */ … }` block that follows the `@media(max-width:1180px)` block. Keep the final `@media(prefers-reduced-motion:reduce) { … }` block and everything before the map-layout comment unchanged.

In `portal/src/styles/listTypography.allow.json`, delete exactly the two entries whose `selector` is `.login-shell .brand-map .headline` and `.login-shell .brand-map .headline .accent` (their rules no longer exist; the guardrail fails on stale entries). Keep the file valid JSON.

- [ ] **Step 8: Delete the old art**

Run: `git rm portal/public/images/login-mountains.png`

- [ ] **Step 9: Run the affected suites**

Run:
```bash
cd portal && npx vitest run src/lib/brandScene.test.ts src/styles/listTypography.test.ts src/pages/Login.test.tsx src/components/login && npx tsc -b
cd ../kiosk && npx vitest run src/pages/Login.test.tsx && npx tsc -b
```
Expected: all PASS; both `tsc` runs print nothing.

- [ ] **Step 10: Commit**

```bash
git add -A portal/src/lib/brandScene.ts portal/src/lib/brandScene.test.ts portal/src/styles/auth-theme.css portal/src/styles/listTypography.allow.json portal/public/images/login-mountains.png
git commit -m "refactor(portal): drop the portal-only map layout from the brand scene

The portal login no longer uses buildBrandScene; the kiosk's classic scene
is unchanged (markup dump identical before and after). Removes the map
styles, their allowlist entries and the old dark mountain crop.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Full suites and visual check against the mockup (controller)

Run by the controller, not an implementer subagent; any fixes go to a fix subagent.

- [ ] **Step 1: Full suites**

```bash
cd portal && npx vitest run && npx tsc -b && npm run build
cd ../kiosk && npx vitest run && npx tsc -b
```
Expected: all pass.

- [ ] **Step 2: Serve the worktree portal**

Add a temporary entry to the MAIN checkout's `.claude/launch.json` running `npm --prefix .claude/worktrees/login-light/portal run dev -- --port 5178 --strictPort`, start it with `preview_start`, open `/login` (no sign-in needed).

- [ ] **Step 3: Compare with the mockup**

Screenshots at 1672×941, 1100×800 and 375×812 (mobile preset). Check against `images/2.webp`: logo/tagline, state names, pins and labels, route and midpoint dot, Route 07 card, headline, features (two-line labels), status line, mountains/clouds bottom-right with no seam, form wording and spacing, no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`), no console errors. Also check the 2FA card styling by rendering it in the test-free way available (inspect CSS only if a live challenge is not reachable without signing in — never type a password).

- [ ] **Step 4: Remove the temporary launch entry**, reset the viewport to desktop, and send Jimmy the 1672×941 and phone screenshots.
