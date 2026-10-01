// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import NavPanel from './NavPanel';

afterEach(cleanup);

const base = { sections: [], openSection: '', onToggleSection: () => {}, mode: 'expanded' as const };

it('shows "Portal" by default and a custom tag when given', () => {
  const { rerender } = render(<MemoryRouter><NavPanel {...base} /></MemoryRouter>);
  expect(screen.getByText('Portal')).toBeTruthy();
  rerender(<MemoryRouter><NavPanel {...base} tag="Sirdar" /></MemoryRouter>);
  expect(screen.getByText('Sirdar')).toBeTruthy();
});
