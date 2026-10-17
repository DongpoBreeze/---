import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importUsda, LEGACY_MANIFEST, EXTENDED_MANIFEST, MANIFEST, NUTRIENTS } from '../scripts/import-usda.mjs';

const root = process.cwd();
const archive = path.join(root, 'artifacts/usda/FoodData_Central_sr_legacy_food_json_2018-04.zip');
const output = path.join(root, 'data/nutrition/usda-sr-legacy.json');

test('expanded USDA output retains the 29 legacy rows and has stable complete schema', async () => {
  const data = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.provider, 'usda-fdc');
  assert.equal(data.dataset, 'SR Legacy 2018-04');
  assert.equal(data.license, 'CC0-1.0');
  assert.match(data.archiveSha256, /^[A-F0-9]{64}$/);
  assert.equal(data.foods.length, MANIFEST.length);
  assert.equal(LEGACY_MANIFEST.length, 29);
  assert.equal(data.foods.length, LEGACY_MANIFEST.length + EXTENDED_MANIFEST.length);
  assert.deepEqual(
    data.foods.slice(0, LEGACY_MANIFEST.length).map(({ id, fdcId }) => [id, fdcId]),
    LEGACY_MANIFEST.map(([id, _label, fdcId]) => [id, fdcId]),
  );
  assert.equal(new Set(data.foods.map((food) => food.id)).size, data.foods.length);
  assert.equal(new Set(data.foods.map((food) => food.fdcId)).size, data.foods.length);
  const aliasOwners = new Map();
  for (const food of data.foods) {
    assert.match(food.id, /^[a-z0-9_]+$/);
    assert.match(food.fdcId, /^\d+$/);
    if (food.aliases !== undefined) {
      assert.ok(Array.isArray(food.aliases) && food.aliases.length > 0);
      assert.ok(food.aliases.every((alias) => typeof alias === 'string' && alias.length > 0 && /[\u3400-\u9fff]/.test(alias)));
      for (const alias of food.aliases) {
        assert.ok(!aliasOwners.has(alias), `duplicate alias ${alias}: ${aliasOwners.get(alias)}/${food.id}`);
        aliasOwners.set(alias, food.id);
      }
    }
    for (const [key, [nutrientId, unit]] of Object.entries(NUTRIENTS)) {
      const value = food.per100g[key];
      assert.ok(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0), `${food.id}/${nutrientId}`);
      assert.ok(unit === 'g' || unit === 'kcal');
    }
  }
});

test('extended catalog rows carry Chinese aliases and distinct preparation identities', async () => {
  const data = JSON.parse(await fs.readFile(output, 'utf8'));
  const extended = data.foods.slice(LEGACY_MANIFEST.length);
  assert.equal(extended.length, EXTENDED_MANIFEST.length);
  assert.ok(extended.every((food) => Array.isArray(food.aliases) && food.aliases.length > 0));
  const find = (id) => data.foods.find((food) => food.id === id);
  assert.notEqual(find('sweet_potato_raw').fdcId, find('sweet_potato_baked').fdcId);
  assert.notEqual(find('salmon_farmed_raw').fdcId, find('salmon_farmed_cooked').fdcId);
  assert.match(find('rice_white_long_grain_raw').preparation, /生/);
  assert.match(find('rice_white_long_grain_cooked').preparation, /熟/);
});

test('raw and cooked identities are retained explicitly', async () => {
  const data = JSON.parse(await fs.readFile(output, 'utf8'));
  const find = (id) => data.foods.find((food) => food.id === id);
  assert.notEqual(find('lotus_root_raw').fdcId, find('lotus_root_boiled').fdcId);
  assert.match(find('lotus_root_raw').description, /raw/i);
  assert.match(find('lotus_root_boiled').description, /cooked/i);
  assert.match(find('egg_raw').preparation, /生/);
  assert.match(find('egg_hard_boiled').preparation, /熟/);
});

test('rerunning against the archive is byte-for-byte reproducible', async () => {
  const temporary = path.join(root, 'artifacts/usda/usda-test-output.json');
  try {
    const first = await importUsda({ archive, output: temporary });
    const expected = await fs.readFile(output, 'utf8');
    const actual = await fs.readFile(temporary, 'utf8');
    assert.equal(actual, JSON.stringify(first, null, 2) + '\n');
    assert.equal(actual, expected);
    assert.equal(first.archiveSha256, JSON.parse(expected).archiveSha256);
  } finally {
    await fs.rm(temporary, { force: true });
  }
});
