// Generate lib/prompts/generated.ts from lib/prompts/**/*.md so prompts are
// COMPILED INTO the backend binary (no runtime fs reads, no .md files shipped
// alongside the binary). Run before `bun build --compile` (and after editing
// any prompt .md). Source-of-truth stays the .md files; this is build-time codegen.
import fs from 'fs';
import path from 'path';

const root = path.resolve('lib/prompts');
const templatesDir = path.join(root, 'templates');
const snippetsDir = path.join(root, 'snippets');

const templates = {};
for (const id of fs.readdirSync(templatesDir)) {
  const dir = path.join(templatesDir, id);
  if (!fs.statSync(dir).isDirectory()) continue;
  const systemFile = path.join(dir, 'system.md');
  const userFile = path.join(dir, 'user.md');
  templates[id] = {
    system: fs.existsSync(systemFile) ? fs.readFileSync(systemFile, 'utf8').trim() : '',
    user: fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8').trim() : '',
  };
}

const snippets = {};
if (fs.existsSync(snippetsDir)) {
  for (const f of fs.readdirSync(snippetsDir)) {
    if (!f.endsWith('.md')) continue;
    snippets[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(snippetsDir, f), 'utf8').trim();
  }
}

const out =
  '// AUTO-GENERATED from lib/prompts/**/*.md by scripts/gen-prompts.mjs — do not edit.\n' +
  '// Bundled into the compiled backend binary so prompts are NOT shipped as\n' +
  '// readable .md files alongside it. Edit the .md sources and re-run the script.\n' +
  'export const PROMPT_TEMPLATES = ' +
  JSON.stringify(templates, null, 2) +
  ' as Record<string, { system: string; user: string }>;\n' +
  'export const PROMPT_SNIPPETS = ' +
  JSON.stringify(snippets, null, 2) +
  ' as Record<string, string>;\n';

fs.writeFileSync(path.join(root, 'generated.ts'), out);
console.log(
  `gen-prompts: ${Object.keys(templates).length} templates, ${Object.keys(snippets).length} snippets -> lib/prompts/generated.ts`,
);
