import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexProvider, prepareLocalCodex } from './local-codex.mjs';

const source = `model_provider = "custom"\nmodel = "different-model"\nmodel_reasoning_effort = "high"\n[model_providers.custom]\nwire_api = "responses"\nbase_url = "http://127.0.0.1:48791/v1"\nexperimental_bearer_token = "fake-provider-secret"\n`;

test('only the active Responses provider is loaded and parser errors do not leak credentials', () => {
  assert.deepEqual(codexProvider(source), { baseUrl: 'http://127.0.0.1:48791/v1', key: 'fake-provider-secret', model: 'different-model', reasoningEffort: 'high' });
  assert.throws(() => codexProvider(source.replace('responses', 'chat')), /must use Responses/);
  assert.throws(() => codexProvider(source.replace('127.0.0.1:48791', 'public.example')), /HTTPS/);
  assert.throws(() => codexProvider(source.replace('/v1"', '/v1?secret=hidden"')), /HTTPS/);
  assert.throws(() => codexProvider(source.replace('"fake-provider-secret"', '"fake-provider-secret')), (error) => !error.message.includes('fake-provider-secret'));
  const envSource = source.replace('experimental_bearer_token = "fake-provider-secret"', 'env_key = "TEST_PROVIDER_KEY"');
  assert.equal(codexProvider(envSource, { TEST_PROVIDER_KEY: 'fake-env-key' }).key, 'fake-env-key');
  assert.throws(() => codexProvider(envSource), /credential/);
});

test('local setup pins the requested model, persists only a separate client token and is repeatable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'health-local-codex-'));
  try {
    const configPath = join(root, 'codex.toml');
    await writeFile(configPath, source);
    const first = await prepareLocalCodex({ projectRoot: root, configPath, env: {} });
    const second = await prepareLocalCodex({ projectRoot: root, configPath, env: {} });
    assert.equal(first.config.modelName, 'different-model');
    assert.equal(first.config.modelReasoningEffort, 'high');
    assert.equal(first.config.modelApiUrl, 'http://127.0.0.1:48791/v1/responses');
    assert.equal(first.config.maxOutputTokens, 8192);
    assert.equal(first.config.upstreamTimeoutMs, 120000);
    assert.equal(first.pricingVerified, false);
    assert.equal(first.config.maxRequestCostCny, 10);
    assert.equal(second.config.accessToken, first.config.accessToken);
    const client = await readFile(join(root, '.env.local'), 'utf8');
    const settings = await readFile(join(root, 'server/data/local-codex.json'), 'utf8');
    assert.equal(client.includes('fake-provider-secret'), false);
    assert.equal(settings.includes('fake-provider-secret'), false);
    assert.equal(await readFile(configPath, 'utf8'), source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unmanaged client configuration is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'health-local-codex-'));
  try {
    const configPath = join(root, 'codex.toml');
    await writeFile(configPath, source);
    await writeFile(join(root, '.env.local'), 'EXPO_PUBLIC_OTHER=existing\n');
    await assert.rejects(prepareLocalCodex({ projectRoot: root, configPath, env: {} }), /Existing .env.local/);
    assert.equal(await readFile(join(root, '.env.local'), 'utf8'), 'EXPO_PUBLIC_OTHER=existing\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
