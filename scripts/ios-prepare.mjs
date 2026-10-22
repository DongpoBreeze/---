import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copySafeSource, createSourceArchive, iosBuildEnvironment, listRegularFiles, sha256 } from './ios-source-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function options(argv) {
  const result = { sourceOnly: false, output: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source-only') result.sourceOnly = true;
    else if (argv[i] === '--output' && argv[i + 1]) result.output = argv[++i];
    else throw new Error('Usage: node scripts/ios-prepare.mjs [--source-only] [--output NEW_DIRECTORY]');
  }
  return result;
}

async function runLogged(name, executable, args, cwd, output) {
  const started = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let spawnError;
  const status = await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: iosBuildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { spawnError = error.code ?? 'SPAWN_ERROR'; });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const log = path.join(output, 'logs', `${name}.log`);
  const header = JSON.stringify({ executable: path.basename(executable), args, started, finished: new Date().toISOString(), exitCode: status.code, signal: status.signal, spawnError });
  await fs.writeFile(log, `${header}\n\nSTDOUT\n${stdout}\nSTDERR\n${stderr}`, 'utf8');
  console.log(`${name}: ${status.code === 0 && !spawnError ? 'passed' : 'failed'} (log: logs/${name}.log)`);
  return { command: [path.basename(executable), ...args], exitCode: status.code, signal: status.signal, spawnError, log: `logs/${name}.log`, stdout, stderr };
}

const publicResult = ({ stdout, stderr, ...result }) => result;

async function inspectNativeConfig(result, output) {
  if (result.exitCode !== 0) return { status: 'failed', ...publicResult(result) };
  const config = JSON.parse(result.stdout);
  const ios = config._internal?.modResults?.ios ?? {};
  const plist = ios.infoPlist ?? {};
  const findings = {
    displayName: plist.CFBundleDisplayName,
    bundleIdentifier: config.ios?.bundleIdentifier,
    marketingVersion: plist.CFBundleShortVersionString,
    buildNumber: plist.CFBundleVersion,
    supportsTablet: config.ios?.supportsTablet,
    camera: plist.NSCameraUsageDescription,
    photos: plist.NSPhotoLibraryUsageDescription,
    microphonePresent: Object.hasOwn(plist, 'NSMicrophoneUsageDescription'),
    faceIdPresent: Object.hasOwn(plist, 'NSFaceIDUsageDescription'),
    healthKitPresent: Object.keys(plist).some((key) => /Health/.test(key)),
    appTrackingPermissionPresent: Object.hasOwn(plist, 'NSUserTrackingUsageDescription'),
    appTransportSecurity: plist.NSAppTransportSecurity,
    exportCompliance: plist.ITSAppUsesNonExemptEncryption,
    entitlements: ios.entitlements,
    privacyManifests: config.ios?.privacyManifests,
    podfileProperties: ios.podfileProperties,
    icon: config.ios?.icon,
  };
  const failures = [];
  if (findings.displayName !== config.name || findings.marketingVersion !== config.version || findings.buildNumber !== config.ios.buildNumber) failures.push('app name or version did not propagate');
  if (!findings.camera || !findings.photos || findings.microphonePresent || findings.faceIdPresent || findings.healthKitPresent || findings.appTrackingPermissionPresent) failures.push('unexpected iOS permission');
  if (findings.appTransportSecurity?.NSAllowsArbitraryLoads !== false) failures.push('arbitrary network loads must stay disabled');
  if (Object.keys(findings.entitlements ?? {}).some((key) => /healthkit|icloud|aps-environment|associated-domains/i.test(key))) failures.push('unrequested signed entitlement');
  await fs.writeFile(path.join(output, 'ios-config-findings.json'), JSON.stringify(findings, null, 2) + '\n', 'utf8');
  return { status: failures.length ? 'failed' : 'passed', ...publicResult(result), findingsFile: 'ios-config-findings.json', findings, failures, limitation: 'Expo config introspection; no Xcode project, CocoaPods install, or compilation is implied.' };
}

async function inspectExport(directory, sourceReport, stage, output) {
  const files = await listRegularFiles(directory);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'));
  const ios = metadata.fileMetadata?.ios;
  if (!ios?.bundle || !files.includes(ios.bundle)) throw new Error('iOS export metadata does not point to an actual bundle.');
  const bundle = await fs.readFile(path.join(directory, ios.bundle));
  const text = bundle.toString('utf8');
  for (const [pattern, reason] of [
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, 'credential-shaped literal'],
    [/data:(?:image|video)\/[\w.+-]+;base64,[A-Za-z0-9+/]{64,}/, 'inline media'],
    [/\b(?:heightCm|weightKg):\d+(?:\.\d+)?\b/, 'prefilled body measurement'],
  ]) {
    if (pattern.test(text)) throw new Error(`The iOS JS export contains a ${reason}; matched values are never logged.`);
  }
  const assetMap = JSON.parse(await fs.readFile(path.join(directory, 'assetmap.json'), 'utf8'));
  const dependencyRoot = await fs.realpath(path.join(stage, 'node_modules'));
  const sourceRoot = await fs.realpath(stage);
  const assets = [];
  const within = (parent, child) => { const relative = path.relative(parent, child); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  for (const asset of Object.values(assetMap)) {
    const sources = [];
    for (const file of asset.files ?? []) {
      const actual = await fs.realpath(file);
      if (within(dependencyRoot, actual)) {
        if (!['png', 'ttf', 'otf', 'woff', 'woff2'].includes(asset.type)) throw new Error('An unexpected dependency media type entered the iOS export.');
        sources.push(`node_modules/${path.relative(dependencyRoot, actual).replaceAll('\\', '/')}`);
      } else if (within(sourceRoot, actual)) {
        const relative = path.relative(sourceRoot, actual).replaceAll('\\', '/');
        if (!sourceReport.entries.some((entry) => entry.path === relative && relative.startsWith('assets/'))) throw new Error('An unapproved project asset entered the iOS export.');
        sources.push(relative);
      } else throw new Error('An asset outside the isolated source or installed dependencies entered the iOS export.');
    }
    if (!sources.length) throw new Error('An exported asset has no auditable source.');
    assets.push({ name: asset.name, type: asset.type, sources });
  }
  const media = files.filter((file) => /\.(?:jpe?g|heic|heif|mov|mp4|webm|sqlite|db|pem|p12|mobileprovision)$/i.test(file));
  if (media.length) throw new Error('Personal media or signing/database files appeared in the iOS resource export.');
  const report = {
    status: 'passed',
    files: files.map((file) => ({ path: file })),
    bundle: { path: ios.bundle, bytes: bundle.length, sha256: sha256(bundle), hermesBytecode: ios.bundle.endsWith('.hbc') },
    assets,
    checks: { isolatedInput: true, developerDotenvDisabled: true, clientEnvironmentInjectionDisabled: true, credentialLiteralDetected: false, bodyMeasurementsPrefilled: false, personalMediaDetected: false },
    limitation: 'This is a JavaScript/resource export for iOS. It is not an Xcode build, a signed IPA, or a device test. assetmap.json is local audit data and is not uploaded by the source allowlist.',
  };
  await fs.writeFile(path.join(output, 'ios-export-audit.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

async function inspectInstalledTemplate(output) {
  const expoPackage = require.resolve('expo/package.json');
  const template = path.join(path.dirname(expoPackage), 'template.tgz');
  const files = [
    'package/ios/Podfile',
    'package/ios/HelloWorld/Info.plist',
    'package/ios/HelloWorld.xcodeproj/project.pbxproj',
  ];
  const results = [];
  // The bundled template is read for evidence. It is not a generated app project.
  for (let index = 0; index < files.length; index += 1) {
    const result = await runLogged(`template-${index + 1}`, 'tar', ['-xOzf', template, files[index]], root, output);
    if (result.exitCode !== 0) return { status: 'unavailable', ...publicResult(result) };
    results.push(result.stdout);
  }
  const deploymentTarget = /platform :ios,.*?\|\|\s*'([^']+)'/.exec(results[0])?.[1];
  const secureStorePodspec = await fs.readFile(path.join(path.dirname(require.resolve('expo-secure-store/package.json')), 'ios/ExpoSecureStore.podspec'), 'utf8');
  const secureStoreMinimum = /:ios\s*=>\s*'([^']+)'/.exec(secureStorePodspec)?.[1];
  const privacy = [];
  const candidates = [
    ['react-native', 'React/Resources/PrivacyInfo.xcprivacy'],
    ['@react-native-async-storage/async-storage', 'ios/PrivacyInfo.xcprivacy'],
    ['expo-file-system', 'ios/PrivacyInfo.xcprivacy'],
    ['expo-secure-store', 'ios/PrivacyInfo.xcprivacy'],
  ];
  for (const [pkg, relative] of candidates) {
    const filename = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), relative);
    try {
      const bytes = await fs.readFile(filename);
      const plist = require('@expo/plist').default ?? require('@expo/plist');
      const content = plist.parse(bytes.toString('utf8'));
      privacy.push({ package: pkg, path: relative, sha256: sha256(bytes), content });
    } catch (error) {
      if (error.code === 'ENOENT') privacy.push({ package: pkg, path: relative, present: false });
      else throw error;
    }
  }
  const report = {
    status: 'inspected',
    bundledTemplate: { package: 'expo', version: JSON.parse(await fs.readFile(expoPackage, 'utf8')).version, iosPodfileDefaultDeploymentTarget: deploymentTarget },
    secureStorePodMinimum: secureStoreMinimum,
    dependencyPrivacyManifests: privacy,
    limitation: 'Installed SDK/template evidence. The effective deployment target and aggregated privacy manifest still require a generated iOS project and CocoaPods/Xcode validation on macOS.',
  };
  await fs.writeFile(path.join(output, 'ios-sdk-template-findings.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

async function main() {
  const configuration = options(process.argv.slice(2));
  const tag = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const output = path.resolve(root, configuration.output ?? `artifacts/ios-preparation-${tag}`);
  if (output === root || !path.basename(output).startsWith('ios-preparation-')) throw new Error('Use a new directory named ios-preparation-* for preparation output.');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  await fs.mkdir(path.join(output, 'logs'));
  const report = {
    createdAt: new Date().toISOString(),
    host: { platform: process.platform, node: process.version, architecture: process.arch },
    output,
    source: { status: 'pending' },
    export: { status: 'not_run' },
    nativePrebuild: { status: 'not_run' },
    xcodeCompile: { status: 'not_run', reason: 'No Xcode compiler is run by this preparation command.' },
    signing: { status: 'not_attempted' },
    ipa: { status: 'not_produced' },
    deviceTest: { status: 'not_run' },
    cloudBuild: { status: 'not_submitted' },
  };
  const save = () => fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  try {
    console.log(`Preparing an isolated iOS source package in ${output}`);
    const source = path.join(output, 'source');
    const sourceReport = await copySafeSource(root, source);
    const archive = await createSourceArchive(source, path.join(output, 'health-compass-ios-source.zip'));
    await fs.writeFile(path.join(output, `${archive.path}.sha256`), `${archive.sha256}  ${archive.path}\n`, 'utf8');
    report.source = { status: 'passed', path: 'source', reviewedFiles: sourceReport.entries.length, bytes: sourceReport.totalBytes, archive };
    await fs.writeFile(path.join(output, 'source-manifest.json'), JSON.stringify(sourceReport, null, 2) + '\n', 'utf8');
    await save();
    if (configuration.sourceOnly) return;

    const stage = path.join(output, 'work');
    await copySafeSource(source, stage);
    // Only the disposable validation worktree receives this link. The source ZIP
    // was already verified and never contains node_modules or any link.
    await fs.symlink(await fs.realpath(path.join(root, 'node_modules')), path.join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    report.localDependencyLink = { path: 'work/node_modules', inArchive: false, limitation: 'Local validation only. The Mac source package installs its own locked dependencies with npm ci.' };
    const expoCli = path.join(stage, 'node_modules/expo/bin/cli');
    const check = await runLogged('typecheck', process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], stage, output);
    report.typecheck = { status: check.exitCode === 0 ? 'passed' : 'failed', ...publicResult(check) };
    const tests = await runLogged('source-policy-tests', process.execPath, ['--import', 'tsx', '--test', '--test-timeout=30000', 'scripts/ios-source-policy.test.mjs'], stage, output);
    report.sourcePolicyTests = { status: tests.exitCode === 0 ? 'passed' : 'failed', ...publicResult(tests) };
    const introspection = await runLogged('expo-ios-introspect', process.execPath, [expoCli, 'config', '--type', 'introspect', '--json'], stage, output);
    report.nativeConfig = await inspectNativeConfig(introspection, output);
    await save();

    const exportResult = await runLogged('expo-ios-export', process.execPath, [expoCli, 'export', '--platform', 'ios', '--output-dir', path.join(output, 'ios-export'), '--no-bytecode', '--dump-assetmap', '--clear', '--max-workers', '2'], stage, output);
    report.export = { status: exportResult.exitCode === 0 ? 'passed' : 'failed', ...publicResult(exportResult), bytecode: false };
    if (exportResult.exitCode === 0) report.export.audit = await inspectExport(path.join(output, 'ios-export'), sourceReport, stage, output);
    await save();

    const native = await runLogged('expo-ios-prebuild', process.execPath, [expoCli, 'prebuild', '--platform', 'ios', '--no-install', '--no-clean', '--skip-dependency-update', 'react,react-native', '--template', path.join(stage, 'node_modules/expo/template.tgz')], stage, output);
    const iosDirectory = await fs.stat(path.join(stage, 'ios')).then((stat) => stat.isDirectory()).catch(() => false);
    report.nativePrebuild = {
      status: native.exitCode === 0 && iosDirectory ? 'generated_without_pods' : 'failed',
      ...publicResult(native),
      nativeDirectoryPresent: iosDirectory,
      podsInstalled: false,
      reason: process.platform === 'win32' && /Skipping generating the iOS native project files/.test(native.stdout + native.stderr) ? 'Expo CLI explicitly skips iOS native project generation on Windows. Re-run on macOS (or Linux for source generation); Xcode compilation requires macOS.' : undefined,
    };
    report.installedSdk = await inspectInstalledTemplate(output);
    await save();
    const validationFailed = [report.typecheck, report.sourcePolicyTests, report.nativeConfig, report.export].some((item) => item.status !== 'passed');
    if (validationFailed) process.exitCode = 1;
    console.log(`Preparation evidence: ${path.join(output, 'verification.json')}`);
    console.log(`Portable managed iOS source: ${path.join(output, archive.path)}`);
    if (!iosDirectory) console.log('Native project generation is incomplete. See logs/expo-ios-prebuild.log and regenerate on macOS.');
    console.log('No Xcode build, signing, cloud build, IPA, or device test was performed.');
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    await save();
    throw error;
  }
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
