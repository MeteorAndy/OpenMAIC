import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const bannedRemoteHosts = /file\.maic\.chat|models\.dev|cdn\.jsdelivr\.net/;

describe('desktop offline assets', () => {
  it('packages the importer PDF worker beside the runtime bundle', () => {
    const importer = readFileSync(join(root, 'public/vendor/maic-importer/index.js'), 'utf8');
    const worker = join(root, 'public/vendor/maic-importer/pdf.worker.min.mjs');

    expect(importer).toContain('/vendor/maic-importer/pdf.worker.min.mjs');
    expect(importer).not.toMatch(bannedRemoteHosts);
    expect(statSync(worker).size).toBeGreaterThan(1_000_000);
  });

  it('generates local aliases for every imported Chinese slide font', () => {
    const fonts = readFileSync(join(root, 'public/vendor/desktop-fonts/fonts.css'), 'utf8');

    for (const family of [
      'SourceHanSans',
      'SourceHanSerif',
      'LXGWWenKai',
      'ZhuQueFangSong',
      'WenDingPLKaiTi',
      'ZcoolHappy',
    ]) {
      expect(fonts).toContain(`font-family: '${family}'`);
    }
    expect(fonts).not.toMatch(bannedRemoteHosts);
  });

  it('keeps interactive HTML on packaged KaTeX assets', () => {
    const postProcessor = readFileSync(
      join(root, 'lib/generation/interactive-post-processor.ts'),
      'utf8',
    );

    expect(postProcessor).toContain('/vendor/katex/katex.min.css');
    expect(postProcessor).toContain('/vendor/katex/katex.min.js');
    expect(postProcessor).not.toMatch(bannedRemoteHosts);
  });
});
