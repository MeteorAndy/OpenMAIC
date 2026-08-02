import { describe, expect, it } from 'vitest';

import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';

describe('interactive HTML post-processing', () => {
  it('injects only packaged KaTeX assets for offline desktop rendering', () => {
    const html = postProcessInteractiveHtml('<html><head></head><body>$x+1$</body></html>');

    expect(html).toContain('/vendor/katex/katex.min.css');
    expect(html).toContain('/vendor/katex/katex.min.js');
    expect(html).toContain('/vendor/katex/contrib/auto-render.min.js');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('\\(x+1\\)');
  });
});
