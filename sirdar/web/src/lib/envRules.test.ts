import { expect, it } from 'vitest';

import { ipv4Problem, nameProblem, portProblem, refProblem } from './envRules';

it('names follow the API rule', () => {
  expect(nameProblem('')).toBe('');
  expect(nameProblem('qa-east')).toBe('');
  expect(nameProblem('Qa')).toMatch(/lowercase letters/);
  expect(nameProblem('qa-')).toMatch(/no trailing hyphen/);
  expect(nameProblem('dev')).toBe('That name is reserved. Choose a different one.');
});

it('refs: branches, tags and SHAs; no leading dash, "..", trailing "/" or ".lock"', () => {
  for (const ok of ['main', 'release/2.8', 'v2.8.1', 'e73b99ca'.repeat(5)]) expect(refProblem(ok)).toBe('');
  expect(refProblem(' ')).toBe('Enter a branch, tag or commit.');
  for (const bad of ['-x', 'a..b', 'feat/', 'x.lock', 'has space', 'a;b']) {
    expect(refProblem(bad)).toBe("That isn't a valid branch, tag or commit.");
  }
});

it('IPv4 addresses and ports', () => {
  expect(ipv4Problem('10.10.48.6', 'proxy IP')).toBe('');
  expect(ipv4Problem('', 'proxy IP')).toBe('Enter the proxy IP.');
  for (const bad of ['10.10.48', '256.1.1.1', '010.1.1.1', 'host']) {
    expect(ipv4Problem(bad, 'proxy IP')).toBe('The proxy IP must be an IPv4 address.');
  }
  expect(portProblem('8000')).toBe('');
  for (const bad of ['0', '65536', '80a', '']) expect(portProblem(bad)).toBe('Use a port from 1 to 65535.');
});
