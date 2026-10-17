# User-configured AI for the Android test build

Date: 2026-10-15. This change follows the user's request to configure their own URL, key, model and reasoning effort in the App. It replaces the proposed hardcoded LAN test gateway.

## Behavior and boundaries

- The Android APK contains no developer gateway address, access token or provider credential. The user's phone connects directly to their chosen HTTPS service.
- Settings contain a base URL, API key, protocol (Responses or Chat Completions), model and optional reasoning effort. Native configuration is held in SecureStore independently of health records; health backups never contain it. Web testing keeps the configuration only for the browser session.
- Fetch `GET /models` with the entered credential. Let users choose returned models and advertised reasoning efforts. Optionally retrieve the selected model's metadata. There is no standard reasoning-capability discovery endpoint: absent metadata means service default, with no guessed supported options or paid probing.
- Changing URL, key, protocol or model invalidates dependent discovery/selection state. Stale discovery responses must not overwrite current input. Saving and deleting settings abort active analysis; old results must not become current.
- Meal recognition remains strictly validated and calculated with the existing USDA data and uncertainty guard. The key is never sent to the old developer gateway, health backup, logs, prompt or model-selection metadata.
- HTTPS is required for every user-entered service address, including loopback. No LAN listener, public tunnel or firewall changes are part of this build.
- Existing offline health features stay free. External AI usage is billed according to the user's selected provider; the development gateway's budget ledger does not govern direct calls.

## Acceptance

1. Start unconfigured, edit connection, request models, select model/advertised effort, save, reopen and delete settings.
2. Verify missing metadata, errors, cancellation and late results. No automatic inference retry or hidden real-provider calls.
3. Mock Responses and Chat Completions requests contain the selected model/effort and preserve nutrition/summary validation.
4. Typecheck, focused unit tests and mobile/desktop UI flows pass; original health backup roundtrip still passes and excludes credentials.
5. Build a standalone signed Android test APK with current code, inspect package/native SecureStore inclusion and verify no bundled developer credentials. Real-device installation and provider-specific compatibility are reported separately.

Official model-list reference: https://developers.openai.com/api/reference/resources/models/methods/list (read on 2026-10-11; basic model metadata has no standard reasoning-effort list).

## Verification on 2026-10-11

- TypeScript checking passed. All 60 client unit tests and 50 retained gateway tests passed using mocked/offline services. Coverage includes both protocols, optional profile fields, unknown nutrition, storage failures, cancellation, and late results.
- `tests/settings-ui.e2e.ts` passed 4/4 on mobile (390 x 844) and desktop (1440 x 1000). It verifies direct selected-provider requests, upstream effort selection, absent capability metadata, stale discovery, HTTPS validation, deletion, and credential exclusion from health ZIPs. Evidence: `artifacts/user-ai-settings-final/`.
- The integrated settings, AI version, and nutrition correction flows passed 8/8 on both viewports (`artifacts/direct-ai-ui-final/`). They cover selected radio accessibility state, page-session reset, USDA calculation, profile edits, late analysis rejection, and two backup restores. A prior run had one timeout after a 54.9-second preview cold start; the completed run used a 120-second browser test budget without changing the app's request limits.
- Android APK: `artifacts/health-compass-arm64-v8a-release-20261011-133629.apk`, 35,798,432 bytes; SHA-256 `10b888f3b30f4615cb4214ddc3d9b921967d58d1f9a6523b7a9be5409267f3fe`. The 46-second build and APK v2 signature check passed. Package `com.healthcompass.app`, Android API 24+, arm64 only, same test certificate as the previous APK.
- All 1,511 APK entries were scanned without finding developer endpoints, developer access token, or provider credential. Native SecureStore, backup exclusions, and current settings/model-discovery/Hermes bundle were verified. Details: [Android testing](android-testing.md).
- No connected phone was available. Installation, upgrade data retention, native permissions, SecureStore operation, and real upstream compatibility remain device checks. This change introduced no real-provider inference requests or new AI charges.
