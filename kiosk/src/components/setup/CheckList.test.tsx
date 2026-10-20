// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CheckList from './CheckList';

describe('CheckList', () => {
  it("shows an informational row's detail on the row's own line, beside its label", () => {
    render(
      <CheckList
        items={[{ name: 'peeler', label: 'Peeler', showOkDetail: true }]}
        results={{ peeler: { state: 'ok', detail: 'Peeler detected · printing in peel-off mode' } }}
        running={null}
      />,
    );
    const detail = screen.getByText('Peeler detected · printing in peel-off mode');
    expect(detail.classList.contains('check-inline')).toBe(true);
    expect(detail.previousElementSibling?.textContent).toBe('Peeler');
  });
});
