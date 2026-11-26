import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDevToolsAlignment } from './verify-devtools.mts';

test('verifyDevToolsAlignment passes across all 3 IDEs, 6 extensions, 4 game engines, native launchers, and 0 legacy refs', () => {
  const res = verifyDevToolsAlignment();
  assert.equal(res.ok, true, `Expected alignment verification to pass: ${res.errors.join('; ')}`);
  assert.equal(res.idesVerified, 3);
  assert.equal(res.extensionsVerified, 6);
  assert.equal(res.gameEnginesVerified, 4);
  assert.equal(res.launcherSourcesVerified, 8);
  assert.equal(res.splashesVerified, 7);
  assert.equal(res.researchDocsVerified, 3);
  assert.deepEqual(res.legacyReferencesFound, []);
});
