// @vitest-environment jsdom
/** NavPanel's own rendering rules: an item with `href` (the Wiki link)
 *  renders as a plain external anchor instead of a router NavLink, in both
 *  the accordion body and the rail's flyout. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import NavPanel from './NavPanel';
import type { NavSection } from './navSections';

const SECTIONS: NavSection[] = [
  {
    label: 'Dashboards',
    icon: <svg />,
    items: [
      { to: '/', label: 'Main Dashboard', resource: 'dashboard', icon: <svg /> },
      { to: '/wiki', label: 'Wiki', resource: 'wiki', href: () => 'https://wiki.example.com', icon: <svg /> },
    ],
  },
];

afterEach(cleanup);

function renderPanel(mode: 'expanded' | 'rail' = 'expanded', openSection = 'Dashboards') {
  return render(
    <MemoryRouter>
      <NavPanel sections={SECTIONS} openSection={openSection} onToggleSection={() => {}} mode={mode} />
    </MemoryRouter>,
  );
}

describe('NavPanel — external nav items', () => {
  it('renders a plain item as a router NavLink', () => {
    renderPanel();
    const link = screen.getByRole('link', { name: 'Main Dashboard' });
    expect(link.getAttribute('href')).toBe('/');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('renders an item with href as an external link that opens in a new tab', () => {
    renderPanel();
    const link = screen.getByRole('link', { name: 'Wiki' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://wiki.example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('renders the same way in the rail\'s flyout', () => {
    renderPanel('rail', 'Dashboards');
    const link = screen.getByRole('link', { name: 'Wiki' });
    expect(link.getAttribute('href')).toBe('https://wiki.example.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
