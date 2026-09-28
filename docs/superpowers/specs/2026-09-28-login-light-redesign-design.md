# Portal login — light redesign (design)

**Date:** 2026-09-28 · **Branch:** `login-light` · **Scope:** portal `/login` only (kiosk unchanged)

## Goal

Rebuild the portal sign-in page to match Jimmy's mockup: one light, warm
page with topo lines, a static Dallas → Las Vegas route map, the headline
and feature row bottom-left, and the sign-in form floating over a mountain
range and cloud band on the right. Use the **real** ServerSherpa logo
(`/images/serversherpa-logo.png`), not the one drawn in the mockup.

Reference images (session scratch, not committed):
- Mockup (1672×941): `images/2.webp`
- Element sheet (1746×901): `images/1.webp`

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Art source | Crop the mountains + clouds from the mockup. Originals may replace the file later. |
| Route motion | Static, exactly as the mockup. No animation. |
| Approach | New static `LoginScene` component (plain markup + inline SVG). The portal stops using `buildBrandScene`. |
| Kiosk | Keeps its classic scene and the shared `auth-theme.css` rules unchanged. |
| Motion | The page is fully still. Only the existing failed-sign-in shake stays. |
| Status line | Stays fixed text, as today. |

## Palette

From the element sheet. Defined as custom properties on the new portal-only
root class (see Architecture):

| Token | Value | Use |
|---|---|---|
| `--lx-ink` | `#0F172A` | Headline, "Sign in", primary button |
| `--lx-orange` | `#FF6A00` | Accent line, eyebrow, route, pins, icons, focus border |
| `--lx-canvas` | `#FFF9F2` | Page background |
| `--lx-slate` | `#64748B` | Body text, mono details, state names |
| `--lx-line` | `#CBD5E1` | Input borders, divider, feature separators |
| `--lx-field` | `#F8FAFC` | Secondary-button and input fill |
| `--lx-ok` | `#22C55E` | Status dot |

Fonts stay the site's own: Geologica (`--font-display`) and Fragment Mono
(`--font-mono`), already loaded.

## Layout (wide screens, ≥ 1280 px — matches the mockup at 1672×941)

One full-viewport canvas (no split panels, no card around the form).

- **Background:** `--lx-canvas` with faint orange topographic contour lines
  across the full width, drawn as inline SVG (sharp at any size).
- **Top left:** the real logo image, then "Server" (`--lx-ink`) + "Sherpa"
  (`--lx-orange`) and "DATACENTER RELOCATION TOOLS" in spaced mono.
- **Map (upper left and center):**
  - State names in spaced gray mono capitals: CALIFORNIA, NEVADA, ARIZONA, TEXAS.
  - **Origin pin** (target symbol, lower): "ORIGIN · DAL-7" in orange mono;
    "Dallas, TX · HALL B"; "32.7767° N / 96.7970° W"; "ELEV. 438'".
  - **Destination pin** (upper right): "DESTINATION · LAS-9"; "Las Vegas, NV · HALL D";
    "36.1696° N / 115.1398° W"; "ELEV. 2,061'".
  - A dashed orange route from the origin up through a glowing midpoint dot
    and on to the destination.
  - **Route 07 card** (white, thin orange border, left of the route):
    "ROUTE 07" / "1,241 ASSETS" / "RACK 83 · ETA 2h 14m", with a short
    leader line to the route.
- **Bottom left:**
  - Headline: "Migration Control." (`--lx-ink`) / "From First Scan to Final Rack." (`--lx-orange`).
  - "Track relocation progress, review manifests, verify assets, and access
    complete migration records." (`--lx-slate`)
  - Four features, orange line icons with thin separators: TRACK ASSETS
    (box), MONITOR PROGRESS (bar chart), VERIFY WORK (shield with check),
    COMPLETE ON TIME (target).
  - A thin rule, then "● ALL SYSTEMS OPERATIONAL | STATUS.SERVERSHERPA.COM"
    (green dot, mono).
- **Right:** the mountain + cloud image rises from the bottom center into
  clouds filling the lower right. The form floats above it in the cream sky,
  about 400 px wide.

Dropped from today's page (not in the mockup): the dark brand panel, the
"People / Process / Technology / Smoother moves." aside and the
"Higher standards" motto.

## The form

Same order and behavior as today; wording and styling change.

1. "SERVERSHERPA PORTAL" eyebrow (orange, spaced mono) with an orange rule to its right.
2. `SystemBanners` stays where it is today (under the eyebrow).
3. **Sign in** heading (`--lx-ink`, bold), then
   "Use the account credentials provided by your migration coordination team."
4. **EMAIL** label and input (white fill, `--lx-line` border, 8 px radius;
   orange border when focused). Placeholder `you@company.com`.
5. **PASSWORD** label with **"Forgot password?"** (was "Forgot?") on the
   right as an underlined link; input with the eye toggle inside.
   The toggle switches between the eye and eye-crossed icons.
6. Error message, unchanged.
7. **Sign in →** primary button: `--lx-ink` fill, white text, orange arrow.
   Hover nudges the arrow right; disabled is gray (element sheet). Loading
   keeps "Signing in…" and the spinner.
8. **OR** divider (thin lines each side).
9. **Continue with SSO** (was "Login with SSO"): white secondary button with
   the orange link icon (replaces the lock icon). Clicking still shows
   "Company SSO isn't enabled yet — sign in with your email and password."
10. "Trouble signing in? **Contact support**" — still opens the Contact
    support card, as does "Forgot password?".

**Two-factor steps** (`totp_verify`, `totp_enroll`) keep all behavior and
copy, restyled to the same light palette (inputs, buttons, links).

## Architecture

- **New `portal/src/components/login/LoginScene.tsx`:** everything left of
  the form — topo lines, logo block, map (one inline SVG for the lines,
  pins and dot; HTML for the labels, card and state names so text renders
  crisply), headline, features, status line, and the mountain image.
  Pure markup, no effects, no props.
- **New `portal/src/components/login/loginIcons.tsx`:** the element sheet's
  line icons as small components (box, bar chart, shield, target, eye,
  eye-off, link, arrow). The portal has no icon library; none is added.
- **New `portal/src/styles/login-light.css`:** all new styles, scoped under
  a new root class `.login-light` on the page. Imported only by the portal
  `Login.tsx`.
- **`portal/src/pages/Login.tsx`:** renders `<div className="login-shell login-light">`
  with `<LoginScene />` and the form. Keeps all state, submit, 2FA, error
  and shake logic. Removes the `buildBrandScene` call, the brand/terrain
  refs and the `data-reveal` attributes (they only fed the entrance
  animation). Keeps importing `auth-theme.css` for the shared form rules it
  still relies on; `login-light.css` overrides what differs.
- **`portal/src/lib/brandScene.ts`:** delete the portal-only `'map'` layout
  (the `layout` option, map drawing, waypoint, callout and the `routeTrip`
  loop). The kiosk's classic scene is untouched. Its tests drop the
  map-layout cases.
- **`portal/src/styles/auth-theme.css`:** delete the now-unused
  `.login-map` / `.brand-map` / `.pane-topo` rules. Nothing the kiosk uses
  changes.
- **`portal/public/images/login-mountains.png`:** deleted once nothing
  references it (it is the old dark-panel crop).

## Art

- **`portal/public/images/login-mountains-light.webp`** (1022×611, committed
  with the plan): cropped from the mockup at x 650–1672, y 330–941. The
  mockup's form was drawn over the clouds, so its fields, buttons and text
  (and the ARIZONA label) were inpainted out (OpenCV Telea plus a feathered
  blur), leaving a soft mist where the form sits. Not truly transparent;
  its background already matches `--lx-canvas`. A CSS `mask-image`
  gradient fades its top and left edges so there is no visible seam.
  Anchored bottom-right at 61.1% of the page width, keeping its aspect
  ratio. A soft cream wash behind the form keeps text readable where the
  art and the form drift apart at other screen shapes.
- Resolution is limited by the 1672 px mockup, so it looks slightly soft on
  large or high-DPI screens. Replacing the file with an original is a
  one-file swap; nothing else depends on its exact size.
- Topo lines, map, pins and icons are drawn in code (no crops).

## Screen sizes

- **≥ 1280 px:** as the mockup.
- **900–1279 px:** the Route 07 card and the state names hide; headline and
  feature row shrink (clamped font sizes).
- **< 900 px (tablets, phones):** map, headline and feature row hide. Logo at
  the top, form centered, mountains and clouds across the bottom, status
  line at the very bottom. Side gutter 16 px on phones.
- No horizontal scrolling at any width.

## Accessibility

- Decorative parts (topo lines, map, mountains, icons) are `aria-hidden`.
- The logo image keeps `alt="ServerSherpa logo"`; headline and feature names
  stay real text.
- **Tab order stays as today:** email → password → Sign in → Continue with
  SSO → Contact support. "Forgot password?" and the eye toggle stay out of
  the Tab order (`tabIndex={-1}`), as today.
- Body text, labels and buttons meet WCAG AA contrast on `--lx-canvas`. The
  brand orange (`--lx-orange`) is used as in the mockup for the eyebrow,
  headline accent and focus border; at roughly 2.75:1 against `--lx-canvas`
  it is below AA for small text — a known trade-off kept for mockup
  fidelity, not a contrast target that was met.
- American English in all copy and comments.

## Testing

- **`Login.test.tsx`:** update for the new wording ("Continue with SSO",
  "Forgot password?"); the SSO hint still appears; "Forgot password?" and
  "Contact support" still open the Contact support card; sign-in, error,
  and both 2FA steps still work; tab order unchanged.
- **New `LoginScene.test.tsx`:** renders the real logo
  (`/images/serversherpa-logo.png`), both pins' labels, the Route 07 card,
  the four features and the status line; decorative wrappers are
  `aria-hidden`; no `buildBrandScene`/GSAP use.
- **`brandScene.test.ts`:** map-layout cases removed; classic cases pass.
- **Kiosk `Login.test.tsx`** passes unchanged.
- **Final checks:** portal and kiosk test suites, `tsc`, portal build,
  kiosk `tsc`. Screenshots of `/login` at 1672×941, ~1100 px and phone
  width (375), compared against the mockup. The login page needs no
  sign-in, so this is fully verifiable.

## Out of scope

- Real SSO, a real password-reset flow, a live status line.
- Any change to the kiosk login's look.
