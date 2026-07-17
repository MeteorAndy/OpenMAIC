/**
 * PBL v2 — Prompt loader
 *
 * Prompts are baked in at BUILD time (scripts/gen-prompts.mjs -> generated.ts)
 * so they compile into the backend binary instead of being shipped as readable
 * .md files. Edit the .md sources, then re-run gen-prompts.mjs.
 */
import { interpolateVariables } from '@/lib/prompts/loader';
import { PBL_V2_PROMPTS } from '@/lib/prompts/generated';

/**
 * Load a PBL v2 prompt by name and interpolate `{{variable}}` slots.
 *
 * Snippet/conditional syntax from `lib/prompts/` is not supported here —
 * PBL v2 prompts are simple variable templates.
 */
export function loadPBLV2Prompt(name: string, variables: Record<string, unknown> = {}): string {
  const template = PBL_V2_PROMPTS[name];
  if (template === undefined) {
    throw new Error(`PBL v2 prompt not found: ${name}`);
  }
  return interpolateVariables(template, variables);
}
