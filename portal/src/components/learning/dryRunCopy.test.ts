import { expect, it } from 'vitest';

import { humanizeCode, reasonText } from './dryRunCopy';

it('puts every reason code the assignment engine sends in plain words', () => {
  const copy: Record<string, string> = {
    never_signed: 'Never signed',
    'valid_until:2027-03-03': 'Valid until Mar 3, 2027',
    'valid_until:never': 'Valid, no end date',
    expired: 'Signed version expired',
    new_version: 'New version published',
    every_initiative: 'Signs again every initiative',
    archived: 'Document is archived',
    not_published: 'Document isn’t published yet',
    already_assigned: 'Already assigned',
    not_on_initiative: 'Not on this initiative',
    already_signed: 'Already signed this version',
    manual: 'Assigned by hand',
  };
  for (const [code, text] of Object.entries(copy)) expect(reasonText(code)).toBe(text);
});

it('humanizes a code it has no copy for', () => {
  expect(reasonText('some_new_reason')).toBe('Some new reason');
  expect(reasonText('valid_until:soon')).toBe('Valid until soon');
  expect(humanizeCode('')).toBe('');
});
