// @vitest-environment jsdom
/** TravelRows — the worker's travel answers as profile rows: Will travel
 *  always, region and restrictions only when filled in. */

import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import TravelRows from './TravelRows';

afterEach(cleanup);

const rows = (w: Parameters<typeof TravelRows>[0]['worker']) => {
  const { container } = render(<dl className="kv"><TravelRows worker={w} /></dl>);
  return [...container.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
};

it('shows a dash when travel is not set and hides empty region and restrictions', () => {
  expect(rows({ will_travel: null, travel_region: null, travel_restrictions: null }))
    .toEqual([['Will travel', '—']]);
});

it('shows Yes or No and the filled-in fields', () => {
  expect(rows({ will_travel: true, travel_region: 'Southeast US', travel_restrictions: 'No overnight flights' }))
    .toEqual([['Will travel', 'Yes'], ['Travel region', 'Southeast US'],
              ['Travel restrictions', 'No overnight flights']]);
  expect(rows({ will_travel: false, travel_region: null, travel_restrictions: 'Day trips only' }))
    .toEqual([['Will travel', 'No'], ['Travel restrictions', 'Day trips only']]);
});
