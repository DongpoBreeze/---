# Mobile testing tools for Health Compass

Research date: 2026-10-11. Scope: choose practical tools for a solo developer on Windows, with Android phone testing now and iOS later. This is a research recommendation, not a completed tool integration or native test acceptance.

The tool and environment observations below are dated snapshots. The later 2026-10-19 APK includes both arm64-v8a and x86_64 and has limited emulator evidence; see [Android testing](android-testing.md). No later tool installation or current device connection is inferred from this research. Current specifications and verification records are indexed in [the documentation guide](README.md).

## Recommendation

Start with **Maestro CLI/MCP + ADB + scrcpy on a dedicated Android test phone**. Keep the existing unit, server and Playwright tests. Add an Android emulator for repeatable device resets and OS/viewport coverage. Introduce Appium only when a concrete system interaction cannot be tested reliably with this setup.

Local Maestro, ADB, scrcpy, Android Emulator and Appium do not require a testing-service subscription. With an existing phone and suitable PC, the initial software subscription cost is zero. Hardware, hosted services and real AI inference are separate costs. Maestro MCP is not currently configured in this Codex session.

## Project evidence and gaps at the research date

- `package.json`: Expo 57, React Native 0.86.3, TypeScript, existing unit tests and Playwright.
- [Development record](development.md): 60 client tests, 50 server tests and 8 integrated Web UI cases previously passed. These historical results were not rerun for this research.
- [Android build record](android-testing.md): standalone `com.healthcompass.app`, API 24+, arm64-v8a only, nondebuggable, cleartext network disabled. Latest recorded APK: `artifacts/health-compass-arm64-v8a-release-20261011-133629.apk`.
- Native persistence, installation/upgrade, permissions, camera/gallery/video, SecureStore and ZIP sharing/restoring remain unverified on a phone.
- Java 17 and Android platform tools are present. No connected Android device was found during this investigation; no emulator/system images, Maestro or Appium installation was found in the inspected environment.
- A normal x86_64 emulator on this Windows x64 host needs a compatible APK, normally a separate x86_64 test build. Do not assume the current arm64-only APK will run on it.
- Existing accessibility labels provide a starting point. Add stable `testID` selectors to important controls where the native hierarchy requires them; verify selectors on the APK.

## Comparison

| Tool | Role in this project | Cost and constraints | Decision |
| --- | --- | --- | --- |
| Maestro CLI + MCP | Repeatable YAML flows; inspect native UI hierarchy, tap/type, assert state, capture screenshots; MCP lets the coding agent invoke these operations. Supports installed Android APKs on physical devices and emulators without adding an in-app test SDK. | Local CLI/MCP/Viewer/Studio are free. CLI is Apache-2.0; Studio is not open source. Native Windows is now supported with Java 17+. Physical iPhones are not supported; iOS testing uses a simulator on macOS. | First choice for Android workflow regression. |
| ADB + scrcpy | Install/upgrade APK, inspect device/logs, mirror and control a phone, record reproducible bug videos. | Free; Android USB debugging/device authorization required. scrcpy is Apache-2.0. Mirroring/recording alone does not assert correctness. | Use alongside Maestro, especially for manual camera and system UI checks. |
| Android Emulator | Repeatable clean device state, OS versions, screen sizes and selected network scenarios. | No testing-service subscription; needs SDK emulator/system image and host resources. Current APK ABI needs adjustment for x86_64. | Add after the first real-device smoke test, or use as an initial target when no phone is available. |
| Appium + UiAutomator2 | More programmable native/system automation, permissions, lifecycle and installation. Usually works with an existing APK without rebuilding it. | Apache-2.0. More server/driver/client setup. UiAutomator2 6.0+ requires API 26+, so it cannot cover our API 24/25 claim. Older-driver support needs separate validation; 5.x also has documented compatibility caveats. | Fallback for specific gaps, not a second complete suite at the start. |
| Detox | React Native tests with synchronization and app instrumentation. | MIT. Requires Android app and test APKs plus native project configuration. Current official RN compatibility lists 0.77.x-0.84.x; our RN 0.86 is outside that list. Expo integration is community maintained. | Defer until compatibility and maintenance benefit are demonstrated. |
| Playwright | Existing Web preview regressions, API response mocks, screenshots and backup checks. | Apache-2.0. Android support is experimental and focuses on Chrome/WebView; it does not replace native RN APK testing. | Keep the current suite. |
| Hosted device testing | Broader manufacturer/OS checks before public distribution. | Maestro Cloud currently lists $250/device/month. Firebase Test Lab is deprecated; its replacement introduces migration and billing considerations below. | Optional later; no paid subscription is justified at this stage. |

## First native test batch

Use synthetic health records, known PNG/JPEG/MP4 fixtures and a test-only API key. Reset/clear-state flows belong on a test device or isolated emulator; upgrade-retention tests must preserve state.

| Priority / scenario | Required result | Execution approach |
| --- | --- | --- |
| P0: Install and upgrade | Cold launch works; updating an existing test install preserves records, media and saved AI configuration. | ADB install/upgrade with the existing signing identity; separate Maestro setup/assert flows. Do not uninstall or clear state in the upgrade case. |
| P0: AI configuration | User enters URL/key; models and advertised efforts load; missing effort metadata uses service default; invalid credentials and errors remain recoverable. Configuration survives process restart. | Maestro + a device-accessible HTTPS mock service; check the mock's received requests. |
| P0: Local records | Meal, training and sleep records survive force-stop/relaunch and can be read or edited without network access. | Maestro + ADB lifecycle operations; controlled offline device test. |
| P0: Media and permissions | Allow/deny/cancel flows work; PNG/JPEG import and video playback work; denial does not prevent unrelated local record entry. | Maestro `addMedia` and gallery flows, plus manual real-camera checks through scrcpy. System picker behavior must be checked per Android version. |
| P0: ZIP roundtrip | Export includes original media and records; restore produces the same data; the API key is absent. Damaged imports do not partially replace existing data. | Automate app steps, verify ZIP contents with a host-side script, and validate the native document/share picker result. A visible success toast is insufficient evidence. |
| P0: Cancellation and stale results | Changing settings, deleting records or cancelling while analysis runs prevents late responses from overwriting current state. Timeout/errors leave the original data usable. | HTTPS mock with controlled delayed/error responses; Maestro assertions and request evidence. |
| P1: Device usability and limits | Large font, small display, long text, background/foreground transitions, large video/backup and storage-pressure cases behave acceptably. | Emulator/device matrix, screenshots and focused manual checks. |

For the first milestone, require all P0 cases to have a recorded pass/fail result on at least one compatible Android device. Save device OS/ABI, APK identity, flow logs, screenshots and relevant sanitized mock-request evidence. Repeat an automated failure after correcting its cause. This establishes one-device acceptance, not full Android API 24+ or iOS coverage.

UI persistence tests verify user-visible SecureStore behavior. They do not independently prove Android Keystore security. AI mock tests verify request handling, not actual nutrition accuracy or upstream service reliability; those need separate representative samples and controlled real-provider checks.

## Native AI mock design

`tests/helpers/mock-ai-provider.ts` currently implements a Playwright browser-route mock. Its `https://provider.example` address is a fixture, not a service reachable by the phone. Native APK traffic will not pass through `page.route`.

Reuse its response fixtures and scenarios in a real test service when implementing native tests. The release APK requires HTTPS with a certificate chain trusted by the device. Installing a user CA or forwarding a port does not, by itself, make an Android release app trust that certificate. Alternatives are a properly trusted HTTPS test endpoint or a separately scoped test build with explicit certificate trust for testing. Do not weaken the release build or embed developer credentials.

Minimum mock scenarios: model list/details, advertised and absent reasoning metadata, selected model/effort request assertions, Responses and Chat Completions, PNG/JPEG input, 401/429/5xx, malformed outputs, timeout, cancellation and late responses. All regression inference responses should be simulated. Real AI calls remain a separate deliberate compatibility check, not an automatic retry path.

## Agent collaboration and adoption order

1. Connect a dedicated test phone, confirm ADB access, install the existing arm64 APK and run a manual smoke test. Use scrcpy for inspection and bug videos.
2. Install Maestro locally and register its bundled `maestro mcp` server for the coding agent. First verify device discovery, one screenshot, UI hierarchy and a minimal launch/assert flow. CLI execution remains available without MCP.
3. Add versioned `.maestro/` flows, fixtures, required selectors and the native HTTPS mock. Store logs/screenshots under `artifacts/`; avoid storing real keys in flow files or recordings.
4. Add an x86_64 test build and an emulator for repeatability. Keep separate clean-install and upgrade-retention flows. Run the small native suite before each distributed APK, alongside the existing fast tests.
5. Add Appium only for demonstrated gaps. Its current Node requirement is `^20.19.0 || ^22.12.0 || >=24.0.0`, with npm 10+. Pin a tested server/driver combination and record Android coverage.
6. For iOS, obtain a Mac/Xcode environment for simulator tests and signed builds. Maestro's simulator coverage does not replace physical iPhone camera, permissions and persistence checks. Evaluate Appium XCUITest or manual device testing for that phase.

## Cloud testing caveat

Firebase Test Lab's official pages now announce full shutdown of the console/API on **2027-09-30**. Its successor, Google Cloud Developer Device Platform (DDP), is currently Preview and requires billing to be enabled.

The current Test Lab page still lists Spark daily quotas of 10 virtual-device and 5 physical-device tests; Blaze includes 60 virtual and 30 physical device minutes per day, then $1 and $5 per device-hour respectively. These are Test Lab terms at the research date, not a free-tier promise for DDP. Migration material describes matching existing rates through 2027-04-30; future prices need rechecking.

Test Lab Robo can explore an APK and collect crashes/screenshots without a scripted test suite. It is not a substitute for explicit backup, key-persistence or upgrade assertions. Coverage depends on the exposed UI hierarchy. Neither Test Lab nor DDP documentation establishes a generally supported remote Appium/ReactNative-Jest service. Do not assume Appium/Detox scripts can simply be uploaded and executed there.

## Official sources

Checked on 2026-10-11; product support and pricing can change.

- Maestro: [Windows installation](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli), [MCP](https://docs.maestro.dev/get-started/maestro-mcp), [Android](https://docs.maestro.dev/get-started/supported-platform/android), [React Native](https://docs.maestro.dev/get-started/supported-platform/react-native), [media injection](https://docs.maestro.dev/reference/commands-available/addmedia), [repository and device limits](https://github.com/mobile-dev-inc/Maestro), [pricing](https://maestro.dev/pricing).
- Expo: [official Maestro E2E workflow example](https://docs.expo.dev/eas/workflows/examples/e2e-tests/). Local tool cost does not imply free unlimited EAS execution.
- Device tools: [scrcpy](https://github.com/Genymobile/scrcpy), [Android Emulator](https://developer.android.com/studio/run/emulator).
- Appium: [repository](https://github.com/appium/appium), [requirements](https://github.com/appium/appium/blob/master/packages/appium/docs/en/quickstart/requirements.md), [UiAutomator2 requirements and commands](https://github.com/appium/appium-uiautomator2-driver/blob/master/README.md).
- Detox: [RN compatibility](https://github.com/wix/Detox/blob/master/README.md), [Expo support](https://github.com/wix/Detox/blob/master/docs/introduction/partials/_getting-started-expo.md), [Android build configuration](https://github.com/wix/Detox/blob/master/docs/introduction/partials/_project-setup-apps-android.mdx), [Windows environment](https://github.com/wix/Detox/blob/master/docs/guide/android-dev-env.md), [system API](https://github.com/wix/Detox/blob/master/docs/api/system.md).
- Playwright: [Android support scope](https://playwright.dev/docs/api/class-android).
- Google device cloud: [Test Lab quotas and retirement](https://firebase.google.com/docs/test-lab/usage-quotas-pricing), [migration FAQ](https://firebase.google.com/docs/test-lab/migrate-faq), [DDP migration](https://docs.cloud.google.com/developer-device-platform/device-run/migrate), [Robo scope](https://firebase.google.com/docs/test-lab/android/robo-ux-test), [DDP framework FAQ](https://docs.cloud.google.com/developer-device-platform/troubleshooting).

## Research completion

Repository configuration, prior validation records, local prerequisites and the cited official documentation were inspected. No tool was installed, MCP server registered, device launched, APK uploaded, subscription enabled or native test executed during this research. The next implementation milestone is the first Android P0 test batch above.
