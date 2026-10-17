import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCropper, parseOptions } from './test-real-food-image.mjs';
import { syntheticImage } from './synthetic-image.mjs';

test('real-photo diagnostics default to the 180-second stage timeout and allow explicit bounds', () => {
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live']).timeoutMs, 180_000);
  assert.equal(parseOptions(['node', 'test-real-food-image.mjs', '--live', '--timeout-ms=120000']).timeoutMs, 120_000);
});

test('Playwright cropper emits a bounded JPEG slice for the supplied normalized region', async () => {
  const cropper = createLocalCropper();
  try {
    const source = syntheticImage();
    const crops = await cropper.createCrops({
      input: { payload: { photos: [source] } },
      regions: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }],
      stage: 'crop_review',
    });
    assert.equal(crops.length, 1);
    assert.match(crops[0], /^data:image\/jpeg;base64,/);
    assert.notEqual(crops[0], source);
    assert.equal(Buffer.from(crops[0].slice(crops[0].indexOf(',') + 1), 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.deepEqual(cropper.history[0].sourcePixels, { x: 7, y: 20, width: 77, height: 62 });
    assert.equal(cropper.history[0].region.x, 0.1);
    assert.equal(cropper.history[0].stage, 'crop_review');
  } finally { await cropper.close(); }
});

test('cropper rejects unrelated stages without launching a browser', async () => {
  const cropper = createLocalCropper();
  try {
    await assert.rejects(cropper.createCrops({ regions: [], stage: 'whole' }), /only available for crop review/);
    assert.deepEqual(cropper.history, []);
  } finally { await cropper.close(); }
});
