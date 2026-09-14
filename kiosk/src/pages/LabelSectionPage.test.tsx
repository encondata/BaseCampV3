// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { LABEL_SECTIONS } from '../lib/labelSections';
import LabelSectionPage from './LabelSectionPage';

afterEach(() => cleanup());

describe.each(LABEL_SECTIONS)('LabelSectionPage for $title', (section) => {
  it('shows the title, coming-soon hint, placeholder notice, and a link back to Label Printing', () => {
    render(<MemoryRouter><LabelSectionPage section={section} /></MemoryRouter>);
    expect(screen.getByText('Kiosk · Label Printing')).toBeTruthy();
    expect(screen.getByRole('heading', { name: section.title })).toBeTruthy();
    const blurbPattern = new RegExp(`^Coming soon\\. ${section.blurb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    expect(screen.getByText(blurbPattern)).toBeTruthy();
    expect(screen.getByText('This section is not available yet.')).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to Label Printing' });
    expect(back.getAttribute('href')).toBe('/labels');
  });
});
