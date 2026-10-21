import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import catalog from '../data/nutrition/usda-sr-legacy.json';
import categories from '../data/nutrition/category-ranges.json';
import { mealRecognitionInstructions } from '../shared/nutrition.mjs';

test('latency control prompt is byte-identical to the frozen original A/B experiment', () => {
  const text = mealRecognitionInstructions('whole', catalog.foods, Object.keys(categories.categories), 'current');
  assert.equal(createHash('sha256').update(text).digest('hex'), 'b441849fae9f4d77c14ba45873a4f16debed46f5f4e128e7a97dd0444b7cf9ae');
  assert.equal(mealRecognitionInstructions('whole', catalog.foods, Object.keys(categories.categories)), text);
});

test('concise requests retain the same schema, catalogue and stage task for a controlled experiment', () => {
  for (const stage of ['whole', 'crop_review', 'final_merge'] as const) {
    const original = mealRecognitionInstructions(stage, catalog.foods, Object.keys(categories.categories), 'current');
    const concise = mealRecognitionInstructions(stage, catalog.foods, Object.keys(categories.categories), 'concise');
    const schema = (text: string) => text.match(/只返回严格 JSON ([\s\S]+?)。/)?.[1];
    assert.equal(schema(concise), schema(original));
    assert.equal(concise.slice(0, concise.indexOf('只返回严格')), original.slice(0, original.indexOf('只返回严格')));
    const directory = JSON.stringify(catalog.foods.map(({ id, label, aliases, preparation }) => [id, label, aliases ?? [], preparation]));
    assert.ok(concise.includes(directory));
    assert.ok(concise.includes(JSON.stringify(Object.keys(categories.categories))));
    assert.ok(concise.length < original.length);
  }
  assert.throws(() => mealRecognitionInstructions('whole', [], [], 'invalid' as 'current'), /Invalid meal prompt profile/);
});
