import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface Workflow {
  jobs: {
    check: {
      steps: Array<{ name?: string; if?: string }>;
    };
  };
}

describe('CI branch guards', () => {
  it('runs the main push package-version gate only on main', () => {
    const workflow = load(
      readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
    ) as Workflow;
    const step = workflow.jobs.check.steps.find(
      (candidate) => candidate.name === 'Package version bumps (main push)',
    );

    expect(step?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });
});
