# Android phone test build

## Latest verified build (2026-10-18 00:27)

- APK: `artifacts/health-compass-arm64-v8a-release-20261018-002719.apk`, 35,931,692 bytes.
- SHA-256: `ef13b136768462233fc3cadfbc8088ed35803274a890030360850322eae98a52`.
- Package: `com.healthcompass.app`, version `0.1.0`, minimum API 24, arm64-v8a only. APK Signature Scheme v2 verification passed.
- The package scanner checked 1,511 entries. SecureStore, model discovery, AI per-100 g nutrition references and the ingredient catalog are present; developer tokens, provider keys, local gateway endpoints and compiled AI environment variables are absent.
- Build log: `artifacts/android-release-20261018-002719.log`; verification JSON was produced by `artifacts/verify-android-build.mjs`.
- No Android phone is connected in this environment, so installation, upgrade data retention, camera permissions and on-device analysis remain unverified.

This project produces a standalone, signed arm64 APK for Android 7.0/API 24 and newer. The package name is `com.healthcompass.app`; the release test build uses the existing `android/app/debug.keystore` so an earlier test install can be upgraded without clearing app data. It is not a store-release signing key.

Build from the ASCII junction so Windows native tools do not receive the Unicode workspace path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\health-compass\scripts\android-build.ps1 `
  -ProjectPath C:\health-compass `
  -AndroidSdkPath C:\Users\14360\AppData\Local\Android\Sdk `
  -Architectures arm64-v8a
```

The script runs Expo prebuild with `--no-clean` so the existing native project and keystore are retained. It synchronizes config plugins, forces a fresh Hermes bundle, sets `EXPO_NO_DOTENV=1`, removes all `EXPO_PUBLIC_AI_*` variables from the Gradle child process, and restores the caller environment afterward. The APK starts with `https://api.bblabu.ai/v1` prefilled as the API address, but contains no access key, selected model, or reasoning effort; users enter a key and choose upstream-provided options in the app. The script never reads `.env.local` or the server's provider configuration.

The timestamped APK, SHA-256 sidecar, latest-copy alias, and Gradle log are written under `artifacts/`. Existing APKs are copied to a `-previous-<timestamp>` name before the latest alias is replaced. The script does not delete app data or prior artifacts.

Inspect an APK before installing:

```powershell
$apk = 'C:\health-compass\artifacts\health-compass-arm64-v8a-release-YYYYMMDD-HHMMSS.apk'
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

## Previous verified build (superseded 2026-10-16)

- APK: `artifacts/health-compass-arm64-v8a-release-20261011-133629.apk`, 35,798,432 bytes.
- SHA-256: `10b888f3b30f4615cb4214ddc3d9b921967d58d1f9a6523b7a9be5409267f3fe`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build completed in 46 seconds. `npm run typecheck` and all 60 unit tests passed. The final build restored its caller environment and left `.env.local` unchanged.
- APK v2 signature verified. Signing-certificate SHA-256 is `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, identical to the prior test APK.
- All 1,511 APK entries were scanned: the local developer token, upstream provider key, local gateway endpoints, compiled gateway environment name, and build sentinel are absent. Embedded Hermes bytecode is 2,591,668 bytes and includes secure settings, model discovery, current nutrition correction/catalog, and the latest radio accessibility property.
- Manifest verification confirms nondebuggable release, cleartext disabled, no network-security override, and SecureStore backup/extraction exclusions. SecureStore's native module is present in DEX.
- Evidence: `artifacts/android-release-20261011-133629.log`, `artifacts/android-apk-signature-20261011-133629.log`, `artifacts/android-apk-package-20261011-133629.log`, `artifacts/android-apk-manifest-20261011-133629.xml`, and `artifacts/android-inspection-health-compass-arm64-v8a-release-20261011-133629/verification.json`.
- `adb devices -l` reported no connected phone. Installation, upgrade data retention, camera permissions, network behavior, and SecureStore operation still require a real phone test.

## Previous verified build (2026-10-15)

- APK: `artifacts/health-compass-arm64-v8a-release-20261015-181542.apk`, 35,836,568 bytes.
- SHA-256: `a2fab9045b2714c411aed22db19e2cebe6408684cbcafeb4d99d489cc3090fd4`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 3m 1s; APK v2 signature verified. The existing test signing identity was reused.
- All 1,511 APK entries passed the existing package verifier; SecureStore and current model discovery, nutrition, and accessibility features were present. The user-provided API key, local developer credentials, and developer gateway endpoints were absent. The provider base URL appears only as the requested default address.
- Connected-device installation and real-device photo analysis remain unverified.

## Previous verified build (2026-10-16)

- APK: `artifacts/health-compass-arm64-v8a-release-20261016-045028.apk`, 35,898,660 bytes.
- SHA-256: `ceeeb9dc259352f906ceb42f283aee46dfe6180c0b0250a49c2aab1c97c6b3a5`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 47 seconds. `apksigner` confirmed one signer and APK Signature Scheme v2. `apkanalyzer` confirmed package ID, min/target SDK, nondebuggable status and package summary.
- All 1,511 APK entries passed `artifacts/android-inspection-health-compass-arm64-v8a-release-20261016-045028/verification.json`: no developer token, upstream API key, local gateway endpoint, compiled AI environment variable or build sentinel. SecureStore, model discovery, nutrition correction and bundled ingredient catalog are present. The configured API address is the public default only; no key, model selection or reasoning strength is embedded.
- Build output: `artifacts/android-release-20261016-045028.log`; SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261016-045028.apk.sha256`.
- `adb devices -l` listed no connected devices. Installation, data-preserving upgrade, native camera/library permissions and on-device photo analysis remain unverified.

## Previous verified build (2026-10-17 02:22)

- APK: `artifacts/health-compass-arm64-v8a-release-20261017-022201.apk`, 35,898,560 bytes.
- SHA-256: `fcc9d3d059c994463cbec41b629a42ab7067ff6ca906f08d68aaf93f3bc84cc2`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build completed in 52 seconds. APK v2 signature verified with the same test certificate as earlier builds. Cleartext traffic is disabled.
- All 1,511 APK entries passed `artifacts/verify-android-build.mjs`: no developer token, upstream API key, local gateway endpoint, compiled AI environment variable or build sentinel. The updated 120-second per-stage timeout is included.
- APK: [Download the Android test build](../artifacts/health-compass-arm64-v8a-release-20261017-022201.apk). SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261017-022201.apk.sha256`.
- `adb devices -l` listed no connected devices. Installation, data-preserving upgrade, native camera/library permissions and on-device photo analysis still require a real phone.

## Latest verified build (2026-10-17 18:33)

- APK: `artifacts/health-compass-arm64-v8a-release-20261017-183330.apk`, 35,910,592 bytes.
- SHA-256: `6b6481ddbcf2812c976c53b0177401536d6da28710d09a4a4c564336e1c47144`.
- Package/version: `com.healthcompass.app`, versionCode `1`, versionName `0.1.0`; minSdk `24`, targetSdk `36`, ABI `arm64-v8a` only.
- Gradle release build succeeded in 47 seconds. APK Signature Scheme v2 verification passed. The package scanner checked 1,511 entries, confirmed SecureStore and the current user-quantity nutrition flow/catalog, and found no developer access token, upstream provider key, local gateway URL or compiled AI environment variable.
- APK: [Download the Android test build](../artifacts/health-compass-arm64-v8a-release-20261017-183330.apk). SHA-256 sidecar: `artifacts/health-compass-arm64-v8a-release-20261017-183330.apk.sha256`.
- Installed to the available Android emulator, but it runs as `x86_64` and failed startup with `SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so`; the APK contains only the arm64 ABI. This is not a real-phone test; a compatible arm64 Android device is still needed for runtime verification.
