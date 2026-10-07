# Sirdar dashboard — Infrastructure lists every environment (design)

Status: approved by Jimmy 2026-10-06. Extends the spotlight design.

## Goal

The Infrastructure section lists **every Sirdar environment** (LAN and
DigitalOcean) with its real parts, not only resources found in a DigitalOcean
inventory. The selected environment (the spotlight's) moves to the top and is
expanded; the others follow in card order, collapsed.

## Tree (top level)

1. One node per Sirdar environment, `id` = the environment's name (the same id
   as its dashboard card), `kind: "environment"`, `type_label` = its type
   (Production / Development / Custom) plus, on DigitalOcean, the account
   ("Development account"), `status`/`dot` rolled up from its children.
2. After the environments: DigitalOcean resources Sirdar doesn't manage, one
   group per account that has any ("Other resources · Development account"),
   collapsed. With one account the group is "Other DigitalOcean resources".
   Demo data keeps its own tree.

## An environment's children

- **DigitalOcean:**
  - Load balancer — its IP, status (from the inventory).
  - One droplet per slot — "Orange (live)" / "Purple (idle)", public IP,
    status, size.
  - Database — name, status, size, the private host as the endpoint.
  - Spaces bucket — name, region.
  - Certificate — the live check's soonest expiry ("47 days left", tone).
  Values come from Sirdar's own records (`do_resources`, `do_slots`,
  `do_environments`) joined to the cached inventory; a resource missing from
  the inventory shows status "Not found". No new DigitalOcean calls.
- **LAN:**
  - Nginx Proxy Manager — its host, status ok/unknown as on the flow.
  - Server — the SSH target's label and host, or the VM's name and address,
    version, health.
  - Certificate — as above.
- **No environment yet** (placeholders) are not listed.

## Order and selection (web)

- The tree is ordered: selected environment, then the remaining environments in
  card order, then the "Other resources" groups.
- Selecting a card (or `?env=`) moves that environment to the top and expands
  it; the previously selected one collapses back unless the user expanded it
  by hand. Expand all / Collapse all keep working.
- Account errors stay as today: a failed account's group shows its error and
  its environments' DigitalOcean children show "Not found"/"unknown".

## Testing

- API: tree for a DigitalOcean two-slot environment, a one-slot one, a LAN SSH
  and a VM environment, a placeholder (absent), untagged resources grouped per
  account, one account failing, demo unchanged.
- Web: selected environment first and expanded; switching selection reorders
  and expands; Expand/Collapse all; the "Other resources" groups last.
