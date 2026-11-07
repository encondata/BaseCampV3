# Sirdar: the first deploy of an A/B environment deploys both sides

Date: 2026-11-07. Branch: `sirdar` (main 4bb05fcc).

## Why

An A/B environment has two sides, A and B: on DigitalOcean the orange and purple slots (production: blue and green), on a VM host (ESXi or Proxmox) the orange and purple app VMs. Each Update deploys one side, the idle one. So after the first deploy only A has a release, and B stays empty until somebody runs a second Update.

Jimmy wants the first deploy to leave both sides running the same release. His words (2026-11-07): "leave them separate but the first time an environment is deployed and A/B is selected once A is finished we immediately roll into B".

## Goal

When an A/B environment's first deploy finishes on side A, Sirdar immediately starts a second, separate deployment that deploys the same commit to side B and leaves B idle.

## What counts as "the first deploy"

The rule depends on state, not on which deployment it is. An Update **triggers the B deployment** when all of these hold:

- it is an A/B Update: `cloud` (DigitalOcean) or `bluegreen` (LAN), `mode == "update"`, on an environment with two slots;
- it **succeeded**, meaning it reached the success path that runs `after_success`;
- it went live (`dep.go_live`), so its slot is now the active one;
- the other slot has **never had a release** (its `do_slots` or `vm_slots` row has no `sha`, or it has no row yet).

Consequences:

- The very first deploy triggers it.
- A first deploy that failed and then succeeded on Retry triggers it when the retry succeeds, because the retry is an Update that went live.
- An environment like rc1 today (orange live, purple never released) doesn't trigger it: its next Update goes to purple, the idle slot, and fills it. (Corrected after review: the earlier text said orange's next Update would trigger it, but no Update goes to orange while purple is idle.)
- Once both sides have a release, it never triggers again.
- A deploy that failed, was cancelled or was interrupted never triggers it. Neither does an Activate, a one-slot environment, or an SSH, single-VM, Proxmox or ESXi environment that isn't A/B.
- A step 20 (Seed starter content) failure leaves the deployment failed (`_seeded_failed`). So B starts only once a Retry of A succeeds.

## The B deployment

- **A separate deployment**, as Jimmy chose: its own row in Deployments, its own log and its own Retry. It is created and launched by Sirdar right after A's success is committed.
- **What it deploys:**
  - mode `update`, slot = the other slot, `go_live=False`;
  - the **same commit**: A's resolved `dep.sha` (full SHA), which is also B's `git_ref` (DigitalOcean's step 0 resolves the ref again, so a branch name could give B a newer commit; changed after the final review);
  - `cloud`/`bluegreen` and `publish`/`vm` as A had them.
- **It never goes live**, even with "Activate automatically" on: B is the idle side, and the next Update goes to it as today.
- **Skips the shared-database one-time work A already did:** no seed snapshot (`snapshot_id=None`, so no restore), `first_admin=False` and `seed_content=False`. Its plan is therefore an ordinary idle-side Update. Step 0 builds B's droplet or VM as it does for any never-built slot.
- **Actor:** A's `actor_id`. Audit row `deploy.deployment_start` with no IP and the usual changes, plus `"follows": <A's deployment id>`.
- **One line at the top of B's first step log:**
  "Sirdar started this deploy after {A's slot} went live: the first deploy puts the same commit on both sides."
  It keeps B self-explanatory without a UI change.

## When it can't start

- **Another deployment is already running** (`DeployInProgress`, for example a user started something in the gap): B isn't started.
- **`create_deployment` refuses** for any other reason (for example `switch_unresolved` on LAN): B isn't started.
- In both cases Sirdar logs a warning, and A's audit/log is not changed. A stays succeeded. The environment is as it is today after a first deploy, so the user's next Update goes to B.
- Nothing retries the start automatically.

## If B fails

A stays live, untouched. B's deployment shows failed like any Update, and Retry works as usual. Nothing starts a third deployment.

## Non-goals

- One deployment that covers both sides (Jimmy chose separate).
- Changing which side a normal Update picks, or Activate.
- Any UI change: B appears in Deployments like any other deployment.

## Anti-goals

- B going live, or touching traffic.
- B re-running the seed restore, first admin or starter content against the shared database.
- A chain: B never triggers anything.
- A's success being affected by anything about B.

## Testing

- **Pipeline, DigitalOcean two-slot:**
  - a first Update that goes live starts a B Update of the other slot with A's sha, `go_live=False`, no snapshot, `first_admin=False`, `seed_content=False`, A's actor, and the log line;
  - B's success starts nothing;
  - a second go-live Update (both sides released) starts nothing.
- **Pipeline, LAN A/B:** the same first-deploy case.
- **Nothing starts:**
  - a failed or cancelled A;
  - an Activate;
  - a one-slot DigitalOcean environment;
  - "Activate automatically" on still gives B `go_live=False`;
  - A succeeded but another deployment is running, so a warning is logged and A stays succeeded;
  - step 20 failed (`_seeded_failed`).
- **Retry:** a failed first deploy whose retry succeeds starts B.
- **Live (Tower):** deploy a new two-slot environment on DigitalOcean with a staging certificate and confirm orange goes live and purple deploys right after, idle. Delete the environment afterwards.

## Left to the builder

- Where exactly in `pipeline.py` the trigger lives: after the success commit, outside A's transaction.
- How the first log line reaches B's first step: the step's initial log, or appended at start.
- Whether the "other slot never released" check reads the slot rows directly or through `do_envs`/`lan_slots` helpers.
