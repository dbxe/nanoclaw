import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import { expandClaudeMdImports } from './opencode.js';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanoclaw-opencode-'));
  tempDirs.push(dir);
  return dir;
}

describe('expandClaudeMdImports', () => {
  it('inlines local @ imports recursively', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'CLAUDE.md'), ['top', '@./shared.md', '@./fragments/domain.md', 'bottom'].join('\n'));
    writeFileSync(join(dir, 'shared.md'), 'shared instructions');
    mkdirSync(join(dir, 'fragments'));
    writeFileSync(join(dir, 'fragments/domain.md'), ['domain start', '@../nested.md', 'domain end'].join('\n'));
    writeFileSync(join(dir, 'nested.md'), 'nested instructions');

    expect(expandClaudeMdImports(join(dir, 'CLAUDE.md'))).toBe(
      ['top', 'shared instructions', 'domain start', 'nested instructions', 'domain end', 'bottom'].join('\n'),
    );
  });

  it('leaves missing imports visible', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'CLAUDE.md'), ['top', '@./missing.md', 'bottom'].join('\n'));

    expect(expandClaudeMdImports(join(dir, 'CLAUDE.md'))).toBe(['top', '@./missing.md', 'bottom'].join('\n'));
  });
});
