# Android phone test build

Updated: 2026-10-22. This file identifies built APKs and their observed device scope. Current-source features and other verification records are indexed in [the documentation guide](README.md).

## Latest integrated build (2026-10-22)

This standalone test APK includes BMI classification and its current/target scale, stage weight advice and adjustable daily-calorie starting recommendations. It preserves the user's latest app name “有节” and icon assets, together with the current local UI changes. It is based on commit `2bffb6f` plus the uncommitted working tree; it has not been pushed to GitHub.

- APK: [health-compass-0.1.3-code4-arm64-v8a-x86_64.apk](../artifacts/android-package-20261022-140633/health-compass-0.1.3-code4-arm64-v8a-x86_64.apk), 54,021,275 bytes.
- SHA-256: `1395ce7bbd09a588cb5de09bbbfe078c45a2a530159db24260cfafd4266e6cd9`.
- Package: `com.healthcompass.app`, versionName `0.1.3`, versionCode `4`, minSdk `24`, targetSdk `36`, ABIs `arm64-v8a` and `x86_64`. Release is nondebuggable and disallows cleartext traffic.
- APK Signature Scheme v2 verified. Signing-certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, matching the previous test APK. The existing test signing identity supports compatible updates; it is not a store-release key.
- The fresh embedded Hermes bundle matches the generated output. Source-map contents match all 21 checked runtime source files, including the shared boundary-safe BMI formatter. The native label, embedded Expo config and generated launcher/adaptive/monochrome icon resources match the current app config and assets. The icon check did not alter the user's source assets.
- All 1,540 APK entries and extracted Hermes strings were checked for common provider-key patterns, known local development endpoints, compiled AI environment names and private configuration files; none matched. Native SecureStore backup exclusions are present. Actual user credentials were not read for the scan, so this does not claim comparison against every local secret.
- Package evidence: [verification.json](../artifacts/android-package-20261022-140633/verification.json). Name/icon evidence: [name-icon-verification.json](../artifacts/android-package-20261022-140633/name-icon-verification.json).
- The body-reference Web flows passed 6/6 in their first full run. After a display-only BMI boundary fix, the targeted unit tests passed 16/16 and mobile/desktop layout tests passed 2/2. See [body-reference acceptance](development.md#profile-health); these Web checks do not establish native device behavior.
- The APK passed an isolated, offline Android 15/API 35 x86_64 smoke test. At 170 cm / 65 kg with “保持健康”, the live result, saved result and cold-restarted result each showed BMI 22.5 / 正常, a 65.0 kg stage target and 1950 kcal/day. Reopened inputs and automatic recommendation mode persisted; cold launch took 486 ms and no fatal runtime error was observed. No credentials were read or entered, and no AI request was sent. See [native verification](../artifacts/android-package-20261022-140633/native-verification.json). Earlier automation failures remain in `native-attempt1/2/3`; the successful test used its isolated emulator, which was shut down afterward.

This package was completed before the subsequent screenshot-inspired BMI layout revision and optional sex/age fields. Those later changes are being verified on Web only at the user's request; the APK above does not include them.

Physical arm64 Android devices, current native real AI, camera capture, full native backup/restore and iOS remain outside this packaging acceptance. A first-time installation requires configuring AI on the phone; browser configuration and health records are not embedded in the APK.

## Personal data isolation recheck (2026-10-22)

The exact 0.1.3 / code 4 APK above was retained without rebuilding; its SHA-256 remains `1395ce7bbd09a588cb5de09bbbfe078c45a2a530159db24260cfafd4266e6cd9`. No embedded saved personal health data, meal media, profile values or private AI configuration was found.

- The actual APK's 1,540 entries passed the data scan. All 392 raster images were traced to generated branding/splash resources (25) or resolved build dependencies (367); missing precompiled AAR origins were checked against the resolved dependency images, with Nine-patch guide borders and transparent RGB normalization explicitly recorded. No personal snapshot, database, nested backup ZIP, video or private configuration payload was found.
- The embedded Hermes bundle and its build-bound source map confirm empty initial profile/health records and a null AI configuration, with no fixed height/weight or inline user media. Public food-reference data and the public default API address remain application resources. Actual user secrets and browser health stores were not read for exact-value comparison.
- A separate offline Android 15 / API 35 x86_64 installation passed the required first-launch checks. Before installation, the package, retained uninstalled package and app data directory were absent, and device backup restore was disabled. The installed `base.apk` hash matched the delivered file. Meals/training/sleep were 0/0/0; height, weight, goal and calorie target were unset; Key was empty, model and effort unconfigured, with no SecureStore configuration or saved user media. The URL field alone retained the public default. No AI or model-discovery requests were made.
- First launch generates local summaries for empty inputs. These runtime derived summaries are not embedded personal history; the initial source state contains no saved summaries. Replacing an existing installation can retain that phone's own data and does not imply that the APK contains the computer's records.

Evidence: [scoped acceptance](../artifacts/apk-data-isolation-20261022/verification.json), [readable report](../artifacts/apk-data-isolation-20261022/report.md), [static audit](../artifacts/apk-data-isolation-20261022/apk-data-audit.json) and [original native run](../artifacts/apk-data-isolation-20261022/fresh-install-verification.json). The native run's `freshInstallPassed` is true; its original overall `passed:false` remains because a separate, optional replacement-install UI step timed out before saving synthetic profile data. That extra step is not claimed as passed. Earlier helper failures and the restored emulator bootstrap image are documented in the readable report; the persistent original qcow2 was not changed. The emulator was shut down, and no phone or browser store was cleared.

This data audit does not add the later Web-only BMI layout or optional sex/age features to the unchanged APK, nor extend its physical-device, iOS or full-function verification scope.

## Earlier UI build (2026-10-22, 0.1.2)

This standalone test APK includes the current local UI changes on top of commit `2bffb6f`, together with the independent meal review screen, nutrition and quantity confirmation, multiple before-meal photos, appearance settings, persistent AI configuration, sleep time selection and exercise templates. The APK includes the local UI changes even though those changes are not yet committed to GitHub.

- APK: [health-compass-arm64-v8a-x86_64-release-20261022-130458.apk](../artifacts/health-compass-arm64-v8a-x86_64-release-20261022-130458.apk), 54,029,845 bytes.
- SHA-256: `500814b1c021dda2c17425fe4bc389b677682b376deb349446171258c1b9e61a`.
- Package: `com.healthcompass.app`, versionName `0.1.2`, versionCode `3`, targetSdk `36`; supports arm64-v8a phones and x86_64 emulators, Android 7.0/API 24 and newer. Release is nondebuggable and disallows cleartext traffic.
- APK Signature Scheme v2 verified. Signing-certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, matching the previous test APK. This is the existing test signing identity, not a store-release key.
- In an isolated x86_64 emulator, installation over 0.1.1 succeeded and the new UI cold-started successfully (`am start -W`: 727 ms). A manually saved meal from the previous APK remained readable after the upgrade. This checks one seeded record, not all historical user data.
- A new manual meal retained 500 kcal, 20 g protein, 60 g carbs and 15 g fat after process restart and reopening. Training and sleep forms opened, and startup in system dark mode completed without a fatal runtime error. The emulator had no active default network. Full native training/sleep save workflows were not exercised.
- All 1,528 APK entries and extracted Hermes strings were checked against known local credentials, developer endpoints, compiled AI environment names and common provider-key patterns; no matches were found. SecureStore and backup exclusions are present. The embedded bundle matches the generated output, and source-map contents match all 16 modified UI files plus the four checked runtime modules.
- No real AI request or personal-device installation was performed. First-time installation requires setting up AI on the phone; browser configuration and local health records are not embedded in the package.
- Current-client tests passed **304/304**. Current Web confirmation/save/reopen flows passed **6/6** across mobile and desktop viewports (meal, sleep and training). An additional legacy meal test failed in both viewports because it expects always-visible nutrition inputs; the current UI requires clicking “修改营养值”. These two failures remain recorded and are not counted as passes. This was not a full Web suite run.
- Build, signature and source/package evidence: [package verification](../artifacts/android-package-20261022-050456/verification.json). Native installation, screenshots and limitations: [native verification](../artifacts/android-package-20261022-050456/native-verification.json). Web results and retained failure traces: [Web verification](../artifacts/android-package-web-20261022/verification.json).

Physical arm64 Android devices, camera capture, current native AI analysis, full native backup/restore and iOS remain outside this packaging acceptance. Historical real-provider and backup checks below belong to their original APKs.

## Previous integrated build (2026-10-19)

This historical package was frozen on 2026-10-19. It includes the initial design A integration, custom effort and native fixes. It does not include the 2026-10-20/21 independent recognition page, later meal-form changes, dark mode, multiple before-meal photos, Web settings persistence, default portions or the current 120-second waiting UI. Those updates are now included in the 2026-10-22 package above; its native verification scope is recorded separately.

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
