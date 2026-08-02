import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop Tauri ACL', () => {
  it('grants native commands only to the fixed loopback application origin', () => {
    const capability = JSON.parse(
      readFileSync(join(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8'),
    );

    expect(capability.remote?.urls).toEqual(['http://127.0.0.1:47823/*']);
    expect(capability.permissions).toContain('desktop-commands');
  });
});
