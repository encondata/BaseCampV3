/**
 * BulkFromToConvert — /bulk/from-to-convert: the shared page shell for
 * Convert a customer From-To. Our template's columns come from the server
 * (they are the guide and the match targets); FromToConvert is the pane.
 * Spec: docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md
 */
import { useEffect, useState } from 'react';

import BulkToolPage from '../components/bulk/BulkToolPage';
import FromToConvert from '../components/bulk/FromToConvert';
import { ApiError, downloadMoveAssetTemplate, getMoveAssetTemplateColumns, type MoveAssetTemplateColumn } from '../lib/api';

export default function BulkFromToConvert() {
  const [columns, setColumns] = useState<MoveAssetTemplateColumn[] | null>(null);
  const [failed, setFailed] = useState<'forbidden' | 'error' | null>(null);

  useEffect(() => {
    let live = true;
    getMoveAssetTemplateColumns()
      .then((c) => { if (live) setColumns(c); })
      .catch((e) => { if (live) setFailed(e instanceof ApiError && e.status === 403 ? 'forbidden' : 'error'); });
    return () => { live = false; };
  }, []);

  return (
    <BulkToolPage
      title="Convert a customer From-To"
      hint={<>
        Upload a customer's From-To in their own layout, match each of their columns to one of ours,
        and download a file in our template's layout. The file is read in this browser and never uploaded.
        Then import it from a move's Import assets page or in Create a move in steps.
      </>}
      guide={(columns ?? []).map((c) => ({ key: c.header, required: c.required, accepts: c.accepts, example: c.example }))}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadMoveAssetTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadMoveAssetTemplate('csv') },
      ]}
      limitNote="The converted file is built in your browser. The From-To import accepts files up to 20 MB."
    >
      {failed === 'forbidden' ? <p className="pf-error">This tool needs company-wide access to moves. Ask an administrator.</p>
        : failed ? <p className="pf-error">Couldn't load our template columns. Reload the page to try again.</p>
        : columns === null ? <p className="page-hint">Loading our template columns…</p>
        : <FromToConvert columns={columns} />}
    </BulkToolPage>
  );
}
