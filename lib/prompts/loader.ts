/**
 * Prompt Loader - Loads prompts from markdown files
 *
 * Supports:
 * - Loading prompts from templates/{promptId}/ directory
 * - Snippet inclusion via {{snippet:name}} syntax
 * - Conditional blocks via {{#if condition}}...{{/if}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

import type { PromptId, LoadedPrompt, SnippetId } from './types';
import { createLogger } from '@/lib/logger';
// Prompts are baked in at BUILD time (scripts/gen-prompts.mjs -> generated.ts)
// so they compile into the backend binary instead of being shipped as readable
// .md files alongside it. Edit the .md sources, then re-run gen-prompts.mjs.
import { PROMPT_TEMPLATES, PROMPT_SNIPPETS } from './generated';
const log = createLogger('PromptLoader');

/**
 * Load a snippet by ID
 */
export function loadSnippet(snippetId: SnippetId): string {
  const snippet = PROMPT_SNIPPETS[snippetId];
  if (snippet === undefined) {
    // Fail loud rather than silently shipping `{{snippet:foo}}` to the LLM.
    // A missing snippet is always a config/typo bug — surface at load time.
    throw new Error(`Snippet not found: ${snippetId}`);
  }
  return snippet;
}

/**
 * Process snippet includes in a template.
 * Replaces {{snippet:name}} with actual snippet content.
 */
export function processSnippets(template: string): string {
  return template.replace(/\{\{snippet:(\w[\w-]*)\}\}/g, (_, snippetId) => {
    return loadSnippet(snippetId as SnippetId);
  });
}

/**
 * Process conditional blocks in a template.
 * Replaces {{#if conditionName}}...{{/if}} with the inner content when the
 * named condition is truthy, or removes the entire block when it is falsy.
 *
 * Blocks do not nest — this is intentional to keep the prompt templating
 * language simple and reviewable.
 */
export function processConditionalBlocks(
  template: string,
  conditions: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, conditionName: string, content: string) => {
      return conditions[conditionName] ? content : '';
    },
  );
}

/**
 * Load a prompt by ID
 */
export function loadPrompt(promptId: PromptId): LoadedPrompt | null {
  const template = PROMPT_TEMPLATES[promptId];
  if (!template) {
    log.error(`Failed to load prompt ${promptId}: not in generated map`);
    return null;
  }
  return {
    id: promptId,
    systemPrompt: processSnippets(template.system),
    userPromptTemplate: processSnippets(template.user),
  };
}

/**
 * Interpolate variables in a template
 * Replaces {{variable}} with values from the variables object
 */
export function interpolateVariables(template: string, variables: Record<string, unknown>): string {
  // `\w+` only matches [A-Za-z0-9_], so kebab-case placeholders like
  // `{{next-agent}}` pass through unchanged. Convention (per README) is
  // camelCase; tests in tests/prompts/templates.test.ts scan templates
  // for non-conforming placeholders.
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined) return match;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  });
}

/**
 * Build a complete prompt with variables.
 *
 * Processing order:
 *   1. Snippet includes ({{snippet:name}}) — file content spliced in
 *   2. Conditional blocks ({{#if flag}}...{{/if}}) — gated on `variables`
 *   3. Variable interpolation ({{varName}}) — values substituted
 */
export function buildPrompt(
  promptId: PromptId,
  variables: Record<string, unknown>,
): { system: string; user: string } | null {
  const prompt = loadPrompt(promptId);
  if (!prompt) return null;

  return {
    system: interpolateVariables(
      processConditionalBlocks(prompt.systemPrompt, variables),
      variables,
    ),
    user: interpolateVariables(
      processConditionalBlocks(prompt.userPromptTemplate, variables),
      variables,
    ),
  };
}
