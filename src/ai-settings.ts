import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createAiSettingsStore } from './ai-settings-store';

const KEY = 'health-compass.ai-settings.v1';
// Web settings live only in this module's memory; keys never enter localStorage,
// the application data store, or exported backups.
const store = createAiSettingsStore(Platform.OS === 'web' ? null : {
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
