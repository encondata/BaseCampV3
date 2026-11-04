// @vitest-environment jsdom
/**
 * components/plans/useSheetEditing.ts: the order of the editing holds on
 * a 100% the completion rules stop. The cell's editor holds editing while
 * it is open; its commit answers with a completion stop, and the
 * completion check takes its own hold before the cell lets go of its one,
 * so the two overlap (as every other 100% path's do) and a refresh that
 * waited never runs between them, under the dialog.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApplyResult } from '../../lib/plans/applyResult';
import { COLUMN_BY_KEY, type PlanColumn } from '../../lib/plans/columns';
import { planView } from '../../lib/plans/merge';
import { makePlan } from '../../lib/plans/planFixtures';
import { selectCell } from '../../lib/plans/selection';
import { CompletionHost } from './useCompletion';
import type { PlanController } from './usePlan';
import { useSheetEditing } from './useSheetEditing';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const STOP: ApplyResult = {
  ok: false, kind: 'confirm', willComplete: [],
  openPredecessors: [{ task_id: 'b', display_id: 2, name: 'Pack', reason: 'predecessor' }],
};

describe('a 100% the rules stop', () => {
  it('the completion check holds editing before the cell lets go: the two holds overlap', async () => {
    const calls: string[] = [];
    const view = planView(makePlan());
    const ctl = {
      status: 'ready', plan: view.plan, outline: view.outline,
      apply: vi.fn(async () => STOP),
      beginEditing: vi.fn((owner: string) => {
        calls.push(`hold:${owner}`);
        return () => { calls.push(`release:${owner}`); };
      }),
      undo: vi.fn(),
    } as unknown as PlanController;
    const columns = ['name', 'percent'].map((k) => COLUMN_BY_KEY.get(k)) as PlanColumn[];
    const wrapper = ({ children }: { children: ReactNode }) => <CompletionHost ctl={ctl}>{children}</CompletionHost>;
    const { result } = renderHook(() => useSheetEditing({
      ctl, columns, rows: ['a', 'b', 'c'], blankRow: false, selection: selectCell('a', 'percent'),
      onSelect: vi.fn(), focusGrid: vi.fn(),
    }), { wrapper });

    act(() => { result.current.open('a', 'percent', null); });
    expect(calls).toEqual(['hold:sheet-cell']);
    act(() => { result.current.commit('100', null, false); });
    await waitFor(() => expect(calls).toContain('release:sheet-cell'));
    expect(ctl.apply).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['a'], percent: 100 }], expect.any(String));
    expect(calls).toEqual(['hold:sheet-cell', 'hold:completion-check', 'release:sheet-cell']);
  });
});
