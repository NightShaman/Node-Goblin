import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/release-node-goblin.yml', import.meta.url), 'utf8');

test('main publishes a fast installable NightShaman development package', () => {
  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /Fast development contract gate/);
  assert.doesNotMatch(workflow, /\(cd gateway && npm test\)|run: npm test/);
  assert.match(workflow, /build-release\.sh gateway\/dist/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /node-goblin-\$VERSION\.tar\.gz/);
  assert.match(workflow, /node-goblin-\$VERSION\.tar\.gz\.sha256/);
});
