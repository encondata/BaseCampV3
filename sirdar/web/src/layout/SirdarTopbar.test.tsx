// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import SirdarTopbar from './SirdarTopbar';

afterEach(cleanup);

it('names the page after Sirdar', () => {
  render(<MemoryRouter initialEntries={['/deploy']}><SirdarTopbar /></MemoryRouter>);
  expect(document.querySelector('.crumbs')!.textContent).toBe('Sirdar/Environments');
});

it('New deployment sits under Environments, which links back', () => {
  render(<MemoryRouter initialEntries={['/deploy/new']}><SirdarTopbar /></MemoryRouter>);
  expect(document.querySelector('.crumbs')!.textContent).toBe('Sirdar/Environments/New deployment');
  expect(screen.getByRole('link', { name: 'Environments' }).getAttribute('href')).toBe('/deploy');
});
