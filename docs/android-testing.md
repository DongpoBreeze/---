# Android phone test build

Updated: 2026-10-21. This file identifies built APKs and their observed device scope. Current-source features and other verification records are indexed in [the documentation guide](README.md).

## Latest integrated build (2026-10-19)

This is the latest **built** package, frozen on 2026-10-19. It includes the initial design A integration, custom effort and native fixes. It does not include the 2026-10-20/21 independent recognition page, later meal-form changes, dark mode, multiple before-meal photos, Web settings persistence, default portions or the current 120-second waiting UI. Those changes are in the working tree and require a new build and device validation.

- APK: [health-compass-arm64-v8a-x86_64-release-20261019-171837.apk](../artifacts/health-compass-arm64-v8a-x86_64-release-20261019-171837.apk), 53,890,469 bytes.
- SHA-256: `22aa4e8d51ed79e322d57db5640d6f9355a1b63019431fcac492c8fb1dab866c`.
- Package: `com.healthcompass.app`, versionName `0.1.1`, versionCode `2`, minSdk `24`, targetSdk `36`, ABIs `arm64-v8a` and `x86_64`. Release is nondebuggable and disallows cleartext traffic.
- APK Signature Scheme v2 verification passed. Signing-certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, matching the existing test builds so compatible installs can be upgraded with `adb install -r`.
- Final Hermes bundle was rebuilt after both native fixes; seven source snapshots, Metro source-map contents and actual embedded bytecode match the fourth source freeze. Settings in this build support upstream, custom and default reasoning effort, together with the minimal frontend meal protocol and user-quantity nutrition calculation. The 16:33 and 16:54 intermediate APKs are superseded.
- Native photo fingerprinting now passes a `Uint8Array` directly to Expo Crypto, as required by its Android bridge. The former `ArrayBuffer` argument failed during gallery import before any model request; the original failure evidence is retained.
- All 1,528 APK entries were checked for local developer credentials, provider credentials, gateway endpoints and compiled AI configuration variables; none were found. Native SecureStore and its Android backup/extraction exclusions are present. Build environment restoration passed.
- Build and package evidence: [verification.json](../artifacts/android-integration-20261019-v011/verification.json), [source freeze](../artifacts/android-integration-20261019-v011/source-before-final-build.json) and [build log](../artifacts/android-integration-20261019-v011/final-build-console.log).
- Final native acceptance: [readable report](../artifacts/android-integration-20261019-v011/final-native-report.md) and [machine-readable report with commands and limits](../artifacts/android-integration-20261019-v011/final-native-report.json).

### Native runtime scope

- Tested the release APK in an isolated Android 15/API 35 x86_64 emulator. It installed over the prior test package and cold-started successfully; the final build's measured startup was 509 ms. No physical phone or iOS device was used.
- Custom effort accepted a valid provider-defined token, rejected invalid input, and retained the saved value after force-stop/relaunch. Selecting custom `high` also persisted. This verifies local configuration behavior, not upstream support for arbitrary tokens.
- Fixed the native modal header overlap found during this run. Center taps on save and close now work normally. The measured status-bar bottom is 128 px; save and close start at 167 px and 160 px, respectively. Insets are measured by a provider within the modal window, rather than by an assumed status-bar height.
- Evidence: [native settings checks](../artifacts/android-integration-20261019-v011/native-settings-test.json), [fixed native settings screenshot](../artifacts/android-integration-20261019-v011/02-native-custom-strength.png), and the separately preserved pre-fix screenshot in the same directory.
- One actual meal submission completed using the runtime local provider, `gpt-6.1-sol` and custom `high`: 29,659 ms, one accepted stage, no retry. The App saved “玉米段”, all four model per-100 g reference ranges and provenance. Initial grams, user quantity and intake totals remained empty; no photograph-based intake was inferred. See [native request](../artifacts/android-integration-20261019-v011/native-analysis-once.json) and [business-result checks](../artifacts/android-integration-20261019-v011/native-result-check.json).
- The imported original remained byte-identical: 7,166 bytes, SHA-256 `5fb07ee8b76a71fb1d4cf3badd638afe60b170af6f7ee17a4117e44e1e977c67`. The actual native analysis copy was 1200×936 / 51,200 bytes and was cleaned after completion. It differs from the earlier frozen Web JPEG, so the native and Web request times are not a controlled comparison. See [photo integrity](../artifacts/android-integration-20261019-v011/native-photo-integrity.json).
- Expo SDK 57's normal runtime installs `expo/fetch` and `TextDecoder` with readable streams. No fetch override was applied during the native request. Buffered-response fallback has offline coverage only and must not be credited as the path tested here.
- Camera permission denial showed a safe fallback; granting permission opened the emulator camera preview, and cancelling returned to the meal form without attaching a photo or sending AI requests. This did not verify a physical camera capture. See [camera checks](../artifacts/android-integration-20261019-v011/native-camera-test.json).
- With the emulator's actual default network disconnected, entering 150 g produced the correct local subtotal. Outward-rounded stored ranges were 127–248 kcal, protein 3.7–7.5 g, carbs 25.5–49.5 g and fat 1.5–4.5 g. All values were checked against the saved per-100 g ranges multiplied by 1.5; the original analysis was retained as a separate version.
- Replacing the same final APK with `adb install -r` while offline preserved the meal, both analysis versions and every meal field exactly, as well as the saved model/custom effort. Other AppData fields also matched after normalizing only `createdAt` for `source=local` derived daily summaries, which are regenerated on cold launch. Original snapshots retain both timestamps; this is not a claim of byte-for-byte equality of the whole AppData object. See [reinstall checks](../artifacts/android-integration-20261019-v011/native-reinstall-test.json) and [numeric and scoped equality checks](../artifacts/android-integration-20261019-v011/native-result-check.json).
- Test credentials were removed through the native settings UI. A subsequent cold restart remained unconfigured while meal/analysis fields and original photo bytes were preserved. SecureStore files were not read or exported. See [credential cleanup](../artifacts/android-integration-20261019-v011/native-credential-cleanup.json).
- Native offline backup export opened the Android system share sheet; it was cancelled without selecting an external recipient. The resulting 15,209-byte ZIP passed length/SHA-256 validation for all ten manifest payloads and retained the exact original photo, meal fields, both analysis versions and portable media paths. No runtime AI connection or credential appeared in any entry. This run tested export and archive integrity, not a native restore. See [backup checks](../artifacts/android-integration-20261019-v011/native-backup-check.json).
- Runtime inspection matched the executable mappings of Hermes, React Native and Expo libraries to x86_64 APK entries and found no fatal runtime errors after the final install. The isolated emulator was then shut down; the ADB device list was empty. Automatic approval twice rejected removal of this task's `emulator-runtime` disk directory with the reason `blocked by policy`; neither deletion command executed, so that directory remains. No original AVD or user service was modified. See [runtime checks](../artifacts/android-integration-20261019-v011/native-runtime-check.json).
- Independent review found no remaining delivery blocker. This verifies one actual Responses request and same-APK replacement in an emulator; live Chat Completions, historical-user-data migration, arm64 physical phones, actual camera capture and iOS are not covered by this run.

## Build and inspect a new test APK

This project produces a standalone, signed APK for Android 7.0/API 24 and newer. The latest integrated APK supports both arm64 phones and x86_64 emulators; the build script defaults to arm64 unless architectures are supplied. The package name is `com.healthcompass.app`; the release test build uses the existing `android/app/debug.keystore` so an earlier test install can be upgraded without clearing app data. It is not a store-release signing key.

Build from the ASCII junction so Windows native tools do not receive the Unicode workspace path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\health-compass\scripts\android-build.ps1 `
  -ProjectPath C:\health-compass `
  -AndroidSdkPath C:\Users\14360\AppData\Local\Android\Sdk `
  -Architectures 'arm64-v8a,x86_64'
```

The script runs Expo prebuild with `--no-clean` so the existing native project and keystore are retained. It synchronizes config plugins, forces a fresh Hermes bundle, sets `EXPO_NO_DOTENV=1`, removes all `EXPO_PUBLIC_AI_*` variables from the Gradle child process, and restores the caller environment afterward. The APK starts with `https://api.bblabu.ai/v1` prefilled as the API address, but contains no access key, selected model, or reasoning effort; users enter a key, select an upstream model and choose an advertised, custom or default effort. The script never reads `.env.local` or the server's provider configuration.

The timestamped APK, SHA-256 sidecar, latest-copy alias, and Gradle log are written under `artifacts/`. Existing APKs are copied to a `-previous-<timestamp>` name before the latest alias is replaced. The script does not delete app data or prior artifacts.

Inspect an APK before installing:

```powershell
$apk = 'C:\health-compass\artifacts\health-compass-arm64-v8a-x86_64-release-YYYYMMDD-HHMMSS.apk'
$sdk = 'C:\Users\14360\AppData\Local\Android\Sdk'
& "$sdk\build-tools\36.0.0\apksigner.bat" verify --verbose $apk
& "$sdk\cmdline-tools\latest\bin\apkanalyzer.bat" manifest application-id $apk
& "$sdk\cmdline-tools\latest\bin\apkanalyzer.bat" manifest min-sdk $apk
& "$sdk\cmdline-tools\latest\bin\apkanalyzer.bat" apk summary $apk
Get-FileHash -Algorithm SHA256 $apk
node C:\health-compass\artifacts\verify-android-build.mjs $apk
```

Install only when a phone is intentionally connected with USB debugging enabled:

```powershell
adb devices
adb install -r $apk
```

The build has no cleartext network allowance. HTTPS gateways work normally; an HTTP gateway is rejected by the client and is not enabled by the Android manifest. No real provider request is part of the build or packaging checks.

## Historical build records

The following results describe each older package at its own test date. Later emulator verification does not retroactively validate these arm64-only packages or physical phones.

### Previous verified build (2026-10-18 01:23)

- APK: `artifacts/health-compass-arm64-v8a-release-20261018-012319.apk`, 35,931,596 bytes.
- SHA-256: `cc83337575da28574f7f34cd07c4b186eeaee46a4f0016d815b651047c0c73c8`.
- Package: `com.healthcompass.app`, version `0.1.0`, minimum API 24, arm64-v8a only. APK Signature Scheme v2 verification passed.
- The package scanner checked 1,511 entries. SecureStore, model discovery, AI per-100 g nutrition references and the ingredient catalog are present; developer tokens, provider keys, local gateway endpoints and compiled AI environment variables are absent.
- Build log: `artifacts/android-release-20261018-012319.log`; verification JSON was produced by `artifacts/verify-android-build.mjs`.
- No physical Android phone was connected for that run. Installation, upgrade data retention, camera permissions and on-device analysis were not accepted by its packaging checks. The later recorded x86_64 launch failure for this arm64-only package is retained in [the development history](development.md).

### Previous verified build (superseded 2026-10-16)

- APK: `artifacts/health-compass-arm64-v8a-release-20261011-133629.apk`, 35,798,432 bytes.
- SHA-256: `10b888f3b30f4615cb4214ddc3d9b921967d58d1f9a6523b7a9be5409267f3fe`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build completed in 46 seconds. `npm run typecheck` and all 60 unit tests passed. The final build restored its caller environment and left `.env.local` unchanged.
- APK v2 signature verified. Signing-certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, identical to the prior test APK.
- All 1,511 APK entries were scanned: the local developer token, upstream provider key, local gateway endpoints, compiled gateway environment name, and build sentinel are absent. Embedded Hermes bytecode is 2,591,668 bytes and includes secure settings, model discovery, current nutrition correction/catalog, and the latest radio accessibility property.
- Manifest verification confirms nondebuggable release, cleartext disabled, no network-security override, and SecureStore backup/extraction exclusions. SecureStore's native module is present in DEX.
- Evidence: `artifacts/android-release-20261011-133629.log`, `artifacts/android-apk-signature-20261011-133629.log`, `artifacts/android-apk-package-20261011-133629.log`, `artifacts/android-apk-manifest-20261011-133629.xml`, and `artifacts/android-inspection-health-compass-arm64-v8a-release-20261011-133629/verification.json`.
- `adb devices -l` reported no connected phone. Installation, upgrade data retention, camera permissions, network behavior, and SecureStore operation still require a real phone test.

### Previous verified build (2026-10-15)

- APK: `artifacts/health-compass-arm64-v8a-release-20261015-181542.apk`, 35,836,568 bytes.
- SHA-256: `a2fab9045b2714c411aed22db19e2cebe6408684cbcafeb4d99d489cc3090fd4`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 3m 1s; APK v2 signature verified. The existing test signing identity was reused.
- All 1,511 APK entries passed the existing package verifier; SecureStore and current model discovery, nutrition, and accessibility features were present. The user-provided API key, local developer credentials, and developer gateway endpoints were absent. The provider base URL appears only as the requested default address.
- Connected-device installation and real-device photo analysis remain unverified.

### Previous verified build (2026-10-16)

- APK: `artifacts/health-compass-arm64-v8a-release-20261016-045028.apk`, 35,898,660 bytes.
- SHA-256: `ceeeb9dc259352f906ceb42f283aee46dfe6180c0b0250a49c2aab1c97c6b3a5`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 47 seconds. `apksigner` confirmed one signer and APK Signature Scheme v2. `apkanalyzer` confirmed package ID, min/target SDK, nondebuggable status and package summary.
- All 1,511 APK entries passed `artifacts/android-inspection-health-compass-arm64-v8a-release-20261016-045028/verification.json`: no developer token, upstream API key, local gateway endpoint, compiled AI environment variable or build sentinel. SecureStore, model discovery, nutrition correction and bundled ingredient catalog are present. The configured API address is the public default only; no key, model selection or reasoning strength is embedded.
- Build output: `artifacts/android-release-20261016-045028.log`; SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261016-045028.apk.sha256`.
- `adb devices -l` listed no connected devices. Installation, data-preserving upgrade, native camera/library permissions and on-device photo analysis remain unverified.

### Previous verified build (2026-10-17 02:22)

- APK: `artifacts/health-compass-arm64-v8a-release-20261017-022201.apk`, 35,898,560 bytes.
- SHA-256: `fcc9d3d059c994463cbec41b629a42ab7067ff6ca906f08d68aaf93f3bc84cc2`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build completed in 52 seconds. APK v2 signature verified with the same test certificate as earlier builds. Cleartext traffic is disabled.
- All 1,511 APK entries passed `artifacts/verify-android-build.mjs`: no developer token, upstream API key, local gateway endpoint, compiled AI environment variable or build sentinel. The updated 90-second per-stage timeout is included.
- APK: [Download the Android test build](../artifacts/health-compass-arm64-v8a-release-20261017-022201.apk). SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261017-022201.apk.sha256`.
- `adb devices -l` listed no connected devices. Installation, data-preserving upgrade, native camera/library permissions and on-device photo analysis still require a real phone.

### Previous verified build (2026-10-17 18:33)

- APK: `artifacts/health-compass-arm64-v8a-release-20261017-183330.apk`, 35,910,592 bytes.
- SHA-256: `6b6481ddbcf2812c976c53b0177401536d6da28710d09a4a4c564336e1c47144`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 47 seconds. APK Signature Scheme v2 verification passed. The package scanner checked 1,511 entries, confirmed SecureStore and the current user-quantity nutrition flow/catalog, and found no developer access token, upstream provider key, local gateway URL or compiled AI environment variable.
- APK: [Download the Android test build](../artifacts/health-compass-arm64-v8a-release-20261017-183330.apk). SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261017-183330.apk.sha256`.
- Installed to the available Android emulator, but it runs as `x86_64` and failed startup with `SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so`; the APK contains only the arm64 ABI. This is not a real-phone test; a compatible arm64 Android device is still needed for runtime verification.
