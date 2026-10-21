import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'smol-toml';
import { parseConfig } from './config.mjs';

export const LOCAL_MODEL = 'gpt-6.1-sol';
export const LOCAL_REASONING = 'max';
const CLIENT_MARKER = '# Health Compass local Codex development configuration';
const SUPPORTED_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function codexProvider(source, env = {}) {
  let document;
  try { document = parse(source); } catch { throw new Error('Cannot parse the local Codex configuration.'); }
  const provider = document.model_providers?.[document.model_provider];
  if (!provider || provider.wire_api !== 'responses') throw new Error('The active Codex provider must use Responses.');
  let base;
  try { base = new URL(provider.base_url); } catch { throw new Error('The active Codex provider needs a valid base URL.'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Error('The Codex provider must use HTTPS or a loopback HTTP endpoint.');
  }
  const key = provider.env_key ? env[provider.env_key] : provider.experimental_bearer_token;
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key) || key.length > 4096) {
    throw new Error('The active Codex provider has no supported bearer credential.');
  }
  const model = document.model ?? LOCAL_MODEL;
  const reasoningEffort = document.model_reasoning_effort ?? LOCAL_REASONING;
  if (typeof model !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(model) || model === '.' || model === '..') {
    throw new Error('The active Codex model setting is invalid.');
  }
  if (typeof reasoningEffort !== 'string' || !SUPPORTED_REASONING.has(reasoningEffort)) {
    throw new Error('The active Codex reasoning setting is invalid.');
  }
  return { baseUrl: base.href, key, model, reasoningEffort };
}

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Cannot read local development settings.'); }
}

/** Read provider address and credential without preparing or writing app config. */
export async function readLocalCodexProvider({ configPath = join(homedir(), '.codex', 'config.toml'), env = process.env } = {}) {
  const source = await optionalText(configPath);
  if (source === undefined) throw new Error('Local Codex configuration was not found.');
  return codexProvider(source, env);
}

export async function prepareLocalCodex({ projectRoot = resolve('.'), configPath = join(homedir(), '.codex', 'config.toml'), env = process.env } = {}) {
  const source = await optionalText(configPath);
  if (source === undefined) throw new Error('Local Codex configuration was not found.');
  const provider = codexProvider(source, env);
  const settingsPath = join(projectRoot, 'server', 'data', 'local-codex.json');
  const clientPath = join(projectRoot, '.env.local');
  const clientSource = await optionalText(clientPath);
  if (clientSource !== undefined && !clientSource.startsWith(`${CLIENT_MARKER}\n`)) {
    throw new Error('Existing .env.local is not managed by this launcher; merge its client settings manually.');
  }
  let settings;
  const saved = await optionalText(settingsPath);
  if (saved === undefined) {
    settings = {
      accessToken: randomBytes(32).toString('hex'),
      monthlyBudgetCny: 300, maxRequestCostCny: 10, safetyReserveCny: 30,
      dailyQuota: 5, pricingVerified: false,
    };
  } else {
    try { settings = JSON.parse(saved); } catch { throw new Error('Invalid local gateway settings.'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid local gateway settings.');
  }
  if (typeof settings.accessToken !== 'string' || !/^[a-f0-9]{64}$/.test(settings.accessToken) || settings.accessToken === provider.key) {
    throw new Error('Invalid local gateway access token.');
  }
  const config = parseConfig({
    HOST: '127.0.0.1', PORT: '8787',
    SERVER_ACCESS_TOKEN: settings.accessToken,
    MODEL_BASE_URL: provider.baseUrl, MODEL_API_PROTOCOL: 'responses', MODEL_API_KEY: provider.key,
    MODEL_NAME: provider.model, MODEL_REASONING_EFFORT: provider.reasoningEffort,
    MODEL_MAX_OUTPUT_TOKENS: '8192', UPSTREAM_TIMEOUT_MS: '120000',
    MONTHLY_BUDGET_CNY: settings.monthlyBudgetCny, MAX_REQUEST_COST_CNY: settings.maxRequestCostCny,
    SAFETY_RESERVE_CNY: settings.safetyReserveCny, INSTALLATION_DAILY_QUOTA: settings.dailyQuota,
    CORS_ORIGINS: 'http://localhost:8082,http://127.0.0.1:8082,http://localhost:8084,http://127.0.0.1:8084',
    HEALTH_DB_PATH: join(projectRoot, 'server', 'data', 'local-codex.sqlite'),
  });
  const clientEnv = { EXPO_PUBLIC_AI_GATEWAY_URL: 'http://127.0.0.1:8787', EXPO_PUBLIC_AI_ACCESS_TOKEN: settings.accessToken };
  const clientText = `${CLIENT_MARKER}\n${Object.entries(clientEnv).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  await mkdir(dirname(settingsPath), { recursive: true });
  if (saved === undefined) await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (clientSource !== clientText) await writeFile(clientPath, clientText, { flag: clientSource === undefined ? 'wx' : 'w', mode: 0o600 });
  return { config, clientEnv, pricingVerified: settings.pricingVerified === true };
}
