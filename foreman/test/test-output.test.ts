import { describe, expect, it } from 'vitest';
import { parseTestOutput } from '../src/repos.js';

describe('Node test runner summaries', () => {
  it.each(['#', 'ℹ'])('reads %s summary lines', (prefix) => {
    expect(parseTestOutput(`${prefix} tests 10\n${prefix} pass 9\n${prefix} fail 1\n`)).toEqual({
      failures: [], summary: 'tests 10, pass 9, fail 1',
    });
  });
});
