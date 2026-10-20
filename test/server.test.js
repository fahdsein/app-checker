import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime supports required platform APIs', () => {
  assert.equal(typeof fetch, 'function');
  assert.equal(typeof crypto.randomUUID, 'function');
});
