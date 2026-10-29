import { afterEach, describe, expect, it } from 'vitest';
import { localize, setLanguage } from '../src/i18n.js';

afterEach(() => setLanguage('en'));

describe("the Foreman's messages in Italian", () => {
  it('rewrites known templates and keeps names, ids, branches and titles', () => {
    setLanguage('it');
    expect(localize('Kit started t2: Tag parser')).toBe('Kit ha iniziato t2: Tag parser');
    expect(localize('Merge t2 "Tag parser" (agentcraft/kit/t2-tag) into main?')).toBe('Unire t2 "Tag parser" (agentcraft/kit/t2-tag) in main?');
    expect(localize('Wren wants to run Bash: npm install chalk@5')).toBe('Wren vuole eseguire Bash: npm install chalk@5');
    expect(localize('Kit: t2 doing -> review')).toBe('Kit: t2 in corso -> revisione');
    expect(localize('Marlow planned the goal into 3 tasks (picked up after a restart)')).toBe("Marlow ha diviso l'obiettivo in 3 task (ripreso dopo un riavvio)");
    expect(localize('Wren needs you (permission): Wren wants to run npm test')).toBe('Wren ti cerca (permesso): Wren vuole eseguire npm test');
    expect(localize('Kit: Merge t3 "X" (b) into main?')).toBe('Kit: Unire t3 "X" (b) in main?');
    expect(localize('Merged agentcraft/kit/t2 into main (abc123, 2 files)')).toBe('Unito agentcraft/kit/t2 in main (abc123, 2 file)');
    expect(localize('something new')).toBe('something new');
  });

  it('English stays English', () => {
    expect(localize('Kit started t2: Tag parser')).toBe('Kit started t2: Tag parser');
  });
});
