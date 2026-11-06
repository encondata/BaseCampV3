# Sirdar: clean up after a failed first deploy, and SSH login retries

Date: 2026-11-05. Branch: `sirdar` (fast-forwarded to main 56521a56).

## Why

A first deploy of `standard` to DigitalOcean failed in step 0 after creating:
- a VPC;
- a Spaces bucket and its key;
- two droplets;
- a managed database cluster with a standby.

Those cost money until someone removes them. The cause was the office network dropping outbound SSH. From Tower, most connections to port 22 time out, while from inside DigitalOcean all 50 connected. The step's single SSH login attempt hit one of the drops.

Jimmy asked for two things:
1. **A clean-up option on a failed first deploy, offering both choices, for every target.**
   - **Remove everything and the environment.** This is what Delete environment does today.
   - **Remove what the deploy built, but keep the environment and its settings,** so the next Deploy starts fresh.
2. **SSH logins that retry** instead of failing on the first dropped connection.

## Goals

1. On a failed first deploy, two clear buttons on the deployment's page:
   - **Remove everything** (the environment goes too);
   - **Clean up and keep settings** (back to a never-deployed environment).
2. Both work on every target: SSH server, Proxmox VM, ESXi VM, LAN Blue/Green, and DigitalOcean.
3. Every SSH connection Sirdar makes during a deploy survives a few dropped connections. This covers Sirdar's own commands and the Ansible host steps.

## Non-goals

- Cleaning up after a failed **update** of an environment that has run before. That would remove a working environment, and Delete environment already covers deliberate removal.
- Automatic clean-up when a deploy fails. A person always chooses, because Retry may be the right answer.
- Fixing the office network.
- New confirmation rules. Both buttons reuse Delete environment's confirmations, described below.

## Anti-goals

- Removing anything Sirdar didn't create or record. The existing teardown ownership checks stay exactly as they are: tags, recorded ids, `managed_records`, and claimed DNS records left in place.
- A clean-up that reports success while something billable is still recorded. The existing "Sirdar still records N DigitalOcean resources" guard applies to both buttons.

## A. When the buttons show

- **Condition (my call, after the builder check).** An environment is "never deployed" when it has **no succeeded `update` and was never adopted** (no deployment of mode `adopt`). This is read from the `deployments` table on every target; `current_sha` isn't asked, because a first Update that failed at smoke, go_live or seed may already have recorded the commit it serves.
  - It covers a first deploy that failed after Start services, the first-admin step or the seed step, for example at DNS, proxy or smoke. Those environments hold only throwaway data, so both buttons are offered.
  - Slot columns (`lan_slots.sha`, `do_slots.sha`) are **not** used: step 10 writes them before the deploy succeeds.
- **Placement (my call for the failed-cleanup case).** The deployment view of the environment's **latest** deployment shows a "Clean up" section next to Retry when:
  - the environment is never deployed;
  - the deployment's status is failed, cancelled or interrupted;
  - the deployment's mode is `update` (a first deploy) or `cleanup` (a clean-up that stopped partway);
  - nothing is running.
  - Retry stays where it is; this section is an alternative to it. After a failed cleanup the page offers Retry (continue the cleanup) plus both buttons. Choosing Remove everything there starts a fresh teardown, which the teardown steps already handle when things are half removed.
- **Copy:**
  - Intro: "This environment has never deployed. Remove what this attempt built:"
  - Button 1: **Clean up and keep settings**. Helper line: "Removes the servers, VMs, cloud resources, proxy hosts and DNS records this attempt made. The environment and its settings stay, and Deploy starts fresh."
  - Button 2: **Remove everything**. Helper line: "The same, and the environment is deleted from Sirdar."
- **Confirmation.** Each button opens a confirm dialog. It uses the existing modal header pattern and rounded corners, and asks for the environment name typed, the same gate as Delete environment (`confirm_name`).
  - There's no snapshot choice: a never-deployed environment has no data. A cleanup never takes a snapshot, on any target.
  - **Production (Jimmy, 2026-11-05: "Same as Delete today"):** both buttons keep production's Delete rules for every attempt, including retries:
    - the environment is marked retiring first;
    - no slot is active;
    - "delete production <name>" is typed as well as the name.
    - The dialog shows the phrase field for production, and the API checks it with `_production_removable` for `cleanup` as it does for `teardown`. A never-deployed production environment that isn't retiring shows the buttons with a hint to mark it retiring in Settings first.
- **Settings stay the same.** The existing Delete environment section in Settings is unchanged.

## B. Remove everything

This is the existing teardown deployment (`mode: "teardown"`), started from the new button. No pipeline change is needed. The button calls the same `POST .../deployments` with `mode: "teardown"` and `confirm_name`. The UI then follows the teardown deployment exactly as DeleteEnvironmentModal does today, including the host-key trust flow.

## C. Clean up and keep settings

- **New deployment mode `cleanup`.** It runs the same plan as `teardown` for the environment's target (same steps 15–18, same per-target plan selection).
  - It is accepted only when the environment is never deployed (`409 cleanup_not_allowed` otherwise).
  - It takes `confirm_name`, and production's rules as decided in Q1.
  - It never snapshots.
- **When it succeeds,** instead of deleting the environment row, the pipeline resets the environment to "never deployed":
  - `env.status = "new"`; `current_sha` and `image_tag` stay null.
  - Every service row's `host_ip` is cleared where the target filled it in (VM and droplet addresses). Ports, hostnames, apps, mail, secrets, digests and the DigitalOcean/VM sizing settings stay.
  - **DigitalOcean:**
    - `do_resources` is empty (the existing guard enforces it).
    - Each `do_slots` row loses `droplet_id`, `public_ip` and `private_ip`.
    - A slot whose host key was already delivered (`host_key_private_enc IS NULL`) gets a new keypair now. `_create_droplet` regenerates one on demand anyway; either is fine, builder's choice.
    - `active_slot` stays null.
  - **Proxmox and ESXi VMs:**
    - The VM rows lose `vmid`/`moref`/`instance_uuid`, any recorded VM snapshots, and the learned address. A static address configured by the user stays.
    - Each gets a **new host keypair**, because today a destroyed VM's key is gone, and step 0 refuses with "Sirdar no longer has the host key it made".
    - The pins for their old addresses are forgotten, as teardown already does.
  - **LAN Blue/Green:** the data VM and both app VMs get the VM reset above, and the `lan_slots` rows go back to never deployed.
  - **SSH server:** step 15 (teardown.yml) removes the stack, data and folder on the host. The saved SSH target and its pinned key are the user's and stay.
  - `managed_records` rows are gone, removed by steps 16–17 as in teardown.
  - **First admin (my call).** If the failed attempt already created the first super admin (step 11 done), that admin lived in the database that was just removed.
    - Cleanup puts the environment's first-admin record back to "needed": `done_at` is cleared, and the email and name are kept.
    - The password was cleared when it was used, so the environment page asks for the first admin again (the existing first-admin entry, as for a new environment) before Deploy. An invitation-style first admin just sends a new invite on the next deploy.
    - The builder adds whatever `first_admins` needs to allow `put` again after a reset.
- **Audit.** Action `deploy.environment_cleanup`, with the environment and deployment, alongside the existing `deploy.environment_delete`.
- **Failure.** A failed cleanup is a normal failed deployment and can be retried from its failed step like a teardown.
  - The environment's status during the run is `deleting`, as teardown sets it.
  - On failure it ends `failed`, as any deploy does. The Clean up section keeps showing because the environment is still never deployed.
- **Afterwards,** the environment page looks like a freshly created environment: Deploy starts at step 0 with the saved settings.

## D. SSH login retries

- **Sirdar's own SSH** (`ssh.run_command`, used by step 0 on DigitalOcean for cloud-init readiness and database grants, by the health check, adopt, ref lookup and backups):
  - Connecting (the host-key fetch plus the login) retries when the connection can't be made: `ConnectFailed` from `unreachable`, meaning a timeout, an OS error, or an SSH error before authentication.
  - **Tries:** 5 attempts, 3 s apart, then the existing "Couldn't reach host:22." error (my call).
  - It never retries a host-key mismatch, an unknown host, a permission-denied, or a command that started. A command that ran is never run twice.
  - `fetch_host_key` and `connect_pinned` share the retry through one helper in `ssh.py`. `test_connection` (the Test button) keeps a single attempt so it answers quickly; builder's call if it reads better retried.
- **Ansible host steps:**
  - The runner sets `ANSIBLE_SSH_RETRIES=5` (my call) and an SSH `ConnectTimeout` of 15 s through the run's environment or a generated `ansible.cfg`.
  - Ansible then retries the connection on exit 255 before marking the host unreachable.
- **Logging.** A retried connection writes one line per retry in the step log: "Couldn't reach 164.92.80.234:22; trying again (2 of 5)." That way a flaky network is visible instead of silent.

## E. Web

- **DeploymentView** gets the Clean up section (A) with both buttons and the confirm dialog (C).
  - The dialog is a small component modeled on DeleteEnvironmentModal: name typed, host-key trust handling, error mapping. It hands the started deployment back so the view follows it.
  - New error codes in `sirdarApi.ts`:
    - `cleanup_not_allowed`: "This environment has deployed before, so clean-up isn't offered. Use Delete environment in Settings."
- The environment list and dashboard show `new` for a cleaned-up environment, as for a created one.

## Testing

- **API:**
  - `cleanup` accepted only for never-deployed environments; refused after a success;
  - the name gate and the production rules;
  - plan equals teardown's for each target;
  - the success path resets each target's rows (DigitalOcean slots, Proxmox/ESXi VM rows with new host keys, LAN Blue/Green, SSH);
  - the do_resources guard;
  - the audit row;
  - a failed cleanup can be retried;
  - a cleaned-up environment's next Update plans step 0 and passes `_prepare` checks with fakes.
- **SSH retry:**
  - connect fails twice then succeeds (one log line per retry);
  - five failures give the old error;
  - mismatch and permission-denied are not retried;
  - a started command is not re-run;
  - the runner passes the Ansible retry settings.
- **Web:**
  - the section shows only for the latest failed first deploy;
  - both buttons, the confirm dialog, errors;
  - following the started deployment.
- **Live (Tower):**
  - Retry `standard` once the network allows SSH. Either way, run **Clean up and keep settings** on it and check DigitalOcean is empty (droplets, database, bucket, VPC) and the environment shows `new`.
  - Then Deploy again, if the network is fixed by then.
  - **Remove everything** is checked on a throwaway LAN or SSH environment.

## Left to the builder

- The exact "never deployed" check for DigitalOcean slots.
- Whether the step log shows "Cleaning up" or "Removing".
- Where the Ansible retry setting lives (environment variable or generated ansible.cfg).
