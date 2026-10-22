import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createAiSettingsStore } from './ai-settings-store';
import { webAiSettingsStorage } from './ai-settings-web';

const KEY = 'health-compass.ai-settings.v1';
// Web uses a separate local IndexedDB database; native keeps using SecureStore.
// Neither credential store is part of the health snapshot or exported backups.
const store = createAiSettingsStore(Platform.OS === 'web' ? webAiSettingsStorage : {
  read: () => SecureStore.getItemAsync(KEY),
  write: (value) => SecureStore.setItemAsync(KEY, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: () => SecureStore.deleteItemAsync(KEY),
});

export const getAiSettings = store.get;
export const getAiSettingsVersion = store.version;
export const onAiSettingsChanged = store.subscribe;
export const loadAiSettings = store.load;
export const saveAiSettings = store.save;
export const clearAiSettings = store.clear;
export const beginAiSettingsRequest = store.beginRequest;
