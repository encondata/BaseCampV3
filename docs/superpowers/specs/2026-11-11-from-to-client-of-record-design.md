# From-To import sets the asset's client of record

Date: 2026-11-11
Status: approved in chat by Jimmy ("build it")
Closes Harbor Master SS-526 and SS-527.
Builds on client groups (SS-525, `2026-11-10-client-groups-design.md`).

## Why

The From-To import never sets `assets.client_id`, so imported assets show on the client's move roster but not on the client's Assets page, in search or in dashboard activity. That also means the client-groups asset rule can't cover them (SS-526).

The importer also matches existing assets by serial across every client. A client's From-To that contains another client's serial attaches that client's asset to this move with no warning (SS-527).

Serials are unique across all clients. A matching serial is the same physical device.

## Decisions (Jimmy, 2026-11-10/11)

1. **The client comes from the move.** On import, an asset's client of record is the client assigned to the initiative. New assets get it, and existing assets with no client get it too. Every real move has a client. A move without one keeps today's behavior: no client is set and no conflicts are flagged.
2. **A serial that already belongs to a different client is flagged at the import check.** Staff choose per row:
   - **Continue:** import the row and change the asset's client of record to this move's client. This is audited.
   - **Skip:** leave the row out. The device stays with its current client and isn't added to this roster.

   **Continue all** and **Skip all** buttons apply to every flagged row. The import can't start until every flagged row has a choice.
3. **The import report (.xlsx)** shows "moved from <client>" or "skipped — belongs to <client>" on those rows.
4. **A one-time fix-up** gives existing roster assets that have no client the client of their move.
5. **The Owner line (my call; Jimmy said "your choice").** The import check summary shows "N Owner values don't match a group", with a link to the client's **Groups › Review**. There is no matching UI inside the import.

## Rules decided while planning (controller rulings)

- **Choices are keyed by serial** and stored on the import job when staff commit. Commit re-runs the pipeline from the file, so choices can't live on the validate results.
- **A conflict that first appears at commit time gets no stored choice, so its row is skipped.** This happens when the device was reassigned between the check and the commit. Skipping fails safe: nothing moves without a decision.
- **Archived assets** whose serial matches still count as conflicts (same device).
- **Fix-up rule:** an asset with no client that sits on several clients' moves gets the client of its newest roster row on a client move. This is the same "newest row" rule as `asset_owner_current`.
- **Owner line count:** distinct non-blank Owner values in the file whose key matches neither a group name nor an alias of the move's client. Dismissed values don't count. Shown only when the move has a client and N > 0.
- **New-move wizard:**
  - The check reads the client from the draft (`payload.move.client_id`).
  - Choices are made on the wizard's assets step and stored on the check job.
  - Create is blocked until every flagged row has a choice.
  - If the draft's client changes after the check, the check is stale and must be run again.
- **Manually attaching assets to a move** (`POST /initiatives/{id}/assets`) is out of scope.
- **Skipped rows count as "left out"** in import notices, like review and error rows.

## Not included

- Any matching UI for Owner values inside the import.
- Moving an asset's existing roster rows on other moves when its client changes. The asset simply belongs to the new client from then on.
- Assets that are on no move (hand-entered). They need a separate asset-level group field.
