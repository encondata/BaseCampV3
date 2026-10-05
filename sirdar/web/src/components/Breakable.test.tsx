// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import Breakable, { breakPoints } from './Breakable';

afterEach(cleanup);

it('offers line breaks after slashes and before dots, @ and ports', () => {
  expect(breakPoints('http://npm.lab.example.com:81/admin'))
    .toEqual(['http://', 'npm', '.lab', '.example', '.com', ':81/', 'admin']);
  expect(breakPoints('jhenderson@encondata.com')).toEqual(['jhenderson', '@encondata', '.com']);
  expect(breakPoints('Set')).toEqual(['Set']);
  expect(breakPoints('')).toEqual(['']);
});

it('renders the same text with <wbr> between the pieces', () => {
  const { container } = render(<dd><Breakable text="info@example.com" /></dd>);
  expect(container.textContent).toBe('info@example.com');
  expect(container.querySelectorAll('wbr')).toHaveLength(2);
});
