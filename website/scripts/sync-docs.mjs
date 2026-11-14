// Refreshes the vendored product docs in seo/docs/ from Arc's group knowledge
// folder, the docs' source of truth. Run when the product docs change:
// ARC_DOCS_DIR="$HOME/Library/Application Support/Arc/groups/<group-id>/knowledge/Docs" pnpm docs:sync
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const from = process.env.ARC_DOCS_DIR;
if (!from) {
  console.error('Set ARC_DOCS_DIR to the folder holding product-definition.md and architecture.md.');
  process.exit(1);
}
for (const file of ['product-definition.md', 'architecture.md']) {
  const to = new URL(`../seo/docs/${file}`, import.meta.url);
  const before = await readFile(to, 'utf8').catch(() => '');
  await copyFile(join(from, file), to);
  const after = await readFile(to, 'utf8');
  console.log(`${file}: ${before === after ? 'unchanged' : 'updated'}`);
}
