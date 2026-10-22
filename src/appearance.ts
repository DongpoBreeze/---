/** Appearance is a device preference, separate from health data and backups. */
export const APPEARANCE_KEY = '@health-compass/appearance-v1';

export type AppearanceMode = 'system' | 'light' | 'dark';
export type AppearanceScheme = 'light' | 'dark';

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveAppearanceScheme(mode: AppearanceMode, systemScheme: unknown): AppearanceScheme {
  return mode === 'system' ? systemScheme === 'dark' ? 'dark' : 'light' : mode;
}

export function parseAppearance(raw: string | null): AppearanceMode {
  if (raw === null) return 'system';
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('已保存的外观设置无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('mode' in value) || !isAppearanceMode(value.mode)) {
    throw new Error('已保存的外观设置无效。');
  }
  return value.mode;
}

export function serializeAppearance(mode: AppearanceMode): string {
  if (!isAppearanceMode(mode)) throw new Error('请选择有效的外观模式。');
  return JSON.stringify({ version: 1, mode });
}
