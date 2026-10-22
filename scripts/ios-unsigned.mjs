import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { copySafeSource, iosBuildEnvironment, listRegularFiles, sha256 } from './ios-source-policy.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const numericVersion = (value) => String(value).split('.').map(Number);
const atLeast = (actual, minimum) => {
  const a = numericVersion(actual), b = numericVersion(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

export function validateUnsignedToolchain({ xcodeVersion, sdkVersion, minimumXcode, minimumIos }) {
  for (const value of [xcodeVersion, sdkVersion, minimumXcode, minimumIos]) {
    if (!/^\d+(?:\.\d+)*$/.test(value ?? '')) throw new Error('Cannot determine the installed Xcode/SDK or dependency minimum versions.');
  }
  if (!atLeast(xcodeVersion, minimumXcode)) throw new Error(`The installed Xcode ${xcodeVersion} is older than React Native's required ${minimumXcode}. Select a newer Xcode.`);
  if (!atLeast(sdkVersion, minimumIos)) throw new Error(`The iPhoneOS SDK ${sdkVersion} cannot build the required iOS ${minimumIos} deployment target.`);
  return { xcodeVersion, sdkVersion, minimumXcode, minimumIos };
}

export function unsignedXcodeArguments({ workspace, scheme, derivedData }) {
  if (!workspace.endsWith('.xcworkspace') || !scheme || !derivedData) throw new Error('A generated workspace, app scheme, and isolated derived data directory are required.');
  return [
    '-workspace', workspace, '-scheme', scheme, '-configuration', 'Release',
    '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derivedData,
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=',
    'DEVELOPMENT_TEAM=', 'ENABLE_BITCODE=NO', 'build',
  ];
}

export function assertUnsignedAppMetadata(plist, expected) {
  if (plist.CFBundleIdentifier !== expected.ios.bundleIdentifier || plist.CFBundleDisplayName !== expected.name || plist.CFBundleShortVersionString !== expected.version || plist.CFBundleVersion !== expected.ios.buildNumber) {
    throw new Error('Built iOS name, bundle ID, marketing version, or build number does not match the reviewed source.');
  }
  for (const permission of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
    if (typeof plist[permission] !== 'string' || !plist[permission]) throw new Error(`Built iOS app is missing ${permission}.`);
  }
  if (Object.keys(plist).some((key) => /Microphone|Health|TrackingUsage|FaceIDUsage/i.test(key))) throw new Error('The compiled iOS app contains an unrequested permission.');
  if (plist.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== false) throw new Error('The compiled iOS app permits arbitrary network loads.');
  if (!plist.MinimumOSVersion || !atLeast(plist.MinimumOSVersion, '16.4')) throw new Error('The built app deployment target is below the installed Expo SDK requirements.');
  if (!plist.CFBundleExecutable || /[\\/]/.test(plist.CFBundleExecutable)) throw new Error('The built app has an invalid executable name.');
  return {
    name: plist.CFBundleDisplayName,
    bundleIdentifier: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString,
    buildNumber: plist.CFBundleVersion,
    minimumIos: plist.MinimumOSVersion,
    executable: plist.CFBundleExecutable,
    appTransportSecurity: plist.NSAppTransportSecurity,
    camera: plist.NSCameraUsageDescription,
    photos: plist.NSPhotoLibraryUsageDescription,
  };
}

export async function auditUnsignedIpa(ipaBytes, { appName, executable, expectedBundleHash }) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(ipaBytes, { checkCRC32: true });
  const prefix = `Payload/${appName}/`;
  if (!appName.endsWith('.app') || /[\\/]/.test(appName)) throw new Error('Invalid IPA app directory.');
  let fileCount = 0;
  for (const [file, member] of Object.entries(zip.files)) {
    if (member.unsafeOriginalName && member.unsafeOriginalName !== file) throw new Error('IPA contains a path traversal entry.');
    if (file !== 'Payload/' && !file.startsWith(prefix)) throw new Error('IPA contains files outside its single app payload.');
    if (file.includes('\\') || file.split('/').some((part) => part === '.' || part === '..')) throw new Error('IPA contains an ambiguous member path.');
    if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.expo|\.codex|backups?|credentials(?:\.[^/]*)?|ai[-_](?:config|settings)(?:\.[^/]*)?)(?:\/|$)/i.test(file)) throw new Error('IPA contains a private configuration or backup path.');
    if (member.dir) continue;
    if (((member.unixPermissions ?? 0) & 0o170000) === 0o120000) throw new Error('IPA archive links require explicit review.');
    if (/(?:^|\/)(?:_CodeSignature|embedded\.mobileprovision)(?:\/|$)|\.(?:p12|pem|key|sqlite3?|db|heic|heif|jpe?g|mp4|mov|webm)$/i.test(file)) throw new Error('IPA contains a signature, provisioning profile, personal data, or unreviewed media.');
    fileCount += 1;
  }
  if (!zip.file(`${prefix}Info.plist`) || !zip.file(`${prefix}${executable}`)) throw new Error('IPA is missing app metadata or its executable.');
  const js = zip.file(`${prefix}main.jsbundle`);
  if (!js || sha256(await js.async('nodebuffer')) !== expectedBundleHash) throw new Error('IPA is missing the verified, freshly built Release JS bundle.');
  return { status: 'passed', fileCount, signatureFiles: 0, provisioningProfiles: 0, personalMediaFiles: 0, payload: prefix };
}

function argumentsFor(argv) {
  const tag = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let output = path.join(root, `artifacts/ios-unsigned-${tag}`);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--output' || !argv[i + 1]) throw new Error('Usage: node scripts/ios-unsigned.mjs [--output NEW_DIRECTORY]');
    output = path.resolve(argv[++i]);
  }
  if (!path.basename(output).startsWith('ios-unsigned-')) throw new Error('Use a new output directory named ios-unsigned-*.');
  return output;
}

async function buildUnsignedIpa() {
  if (process.platform !== 'darwin') throw new Error('An unsigned iPhone app still requires macOS and Xcode. Run the manual ios-unsigned workflow or this source package on a Mac. Windows cannot compile it.');
  const output = argumentsFor(process.argv.slice(2));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  await fs.mkdir(path.join(output, 'logs'));
  const report = { status: 'started', signingStatus: 'UNSIGNED', directlyInstallable: false, requiresResigning: true, platform: process.platform, startedAt: new Date().toISOString(), commands: [] };
  const save = () => fs.writeFile(path.join(output, 'build-summary.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const environment = { ...iosBuildEnvironment(), NODE_BINARY: process.execPath, RCT_NO_LAUNCH_PACKAGER: '1', FORCE_BUNDLING: '1' };
  const run = async (name, executable, args, cwd, { allowFailure = false } = {}) => {
    let stdout = '', stderr = '', spawnError;
    const result = await new Promise((resolve) => {
      const child = spawn(executable, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => { spawnError = error.code ?? 'SPAWN_ERROR'; });
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    });
    const log = `logs/${name}.log`;
    await fs.writeFile(path.join(output, log), JSON.stringify({ executable: path.basename(executable), args, ...result, spawnError }) + `\n\nSTDOUT\n${stdout}\nSTDERR\n${stderr}`, 'utf8');
    report.commands.push({ name, executable: path.basename(executable), args, ...result, spawnError, log });
    await save();
    console.log(`${name}: exit ${result.exitCode}`);
    if ((result.exitCode !== 0 || spawnError) && !allowFailure) throw new Error(`${name} failed. Read ${log}. No successful IPA is claimed.`);
    return { ...result, stdout, stderr };
  };
  try {
    const stage = path.join(output, 'work');
    const source = await copySafeSource(root, stage);
    report.source = { reviewedFiles: source.entries.length, bytes: source.totalBytes, files: source.entries };
    // Build dependencies are an installed, locked tree in the parent checkout;
    // no developer data or native project is copied into this isolated build.
    await fs.symlink(await fs.realpath(path.join(root, 'node_modules')), path.join(stage, 'node_modules'), 'dir');
    const xcode = await run('xcode-version', 'xcodebuild', ['-version'], stage);
    const sdk = await run('iphoneos-sdk', 'xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'], stage);
    await run('cocoapods-version', 'pod', ['--version'], stage);
    const expoCli = path.join(stage, 'node_modules/expo/bin/cli');
    await run('expo-prebuild-ios', process.execPath, [expoCli, 'prebuild', '--platform', 'ios', '--no-install', '--no-clean', '--skip-dependency-update', 'react,react-native', '--template', path.join(stage, 'node_modules/expo/template.tgz')], stage);
    const ios = path.join(stage, 'ios');
    const podfile = await fs.readFile(path.join(ios, 'Podfile'), 'utf8');
    const properties = JSON.parse(await fs.readFile(path.join(ios, 'Podfile.properties.json'), 'utf8'));
    const helpers = await fs.readFile(path.join(stage, 'node_modules/react-native/scripts/cocoapods/helpers.rb'), 'utf8');
    const minimumXcode = /def self\.min_xcode_version_supported\s+return\s+'([^']+)'/.exec(helpers)?.[1];
    const minimumIos = properties['ios.deploymentTarget'] ?? /platform :ios,.*?\|\|\s*'([^']+)'/.exec(podfile)?.[1];
    report.toolchain = validateUnsignedToolchain({ xcodeVersion: /Xcode\s+(\d+(?:\.\d+)*)/.exec(xcode.stdout)?.[1], sdkVersion: sdk.stdout.trim(), minimumXcode, minimumIos });
    await save();
    // CocoaPods aggregates the installed modules' real privacy manifests. Do not
    // synthesize a list of required-reason APIs from documentation guesses.
    await run('pod-install', 'pod', ['install', `--project-directory=${ios}`], stage);
    const nativeEntries = await fs.readdir(ios);
    const projects = nativeEntries.filter((name) => name.endsWith('.xcodeproj'));
    const workspaces = nativeEntries.filter((name) => name.endsWith('.xcworkspace'));
    if (projects.length !== 1 || workspaces.length !== 1) throw new Error('Expected one generated app Xcode project and workspace.');
    const schemes = (await fs.readdir(path.join(ios, projects[0], 'xcshareddata/xcschemes'))).filter((name) => name.endsWith('.xcscheme')).map((name) => name.slice(0, -'.xcscheme'.length));
    if (schemes.length !== 1) throw new Error('Select an explicit app scheme: the generated Xcode project is ambiguous.');
    const derivedData = path.join(output, 'derived-data');
    await run('xcodebuild-release-unsigned', 'xcodebuild', unsignedXcodeArguments({ workspace: path.join(ios, workspaces[0]), scheme: schemes[0], derivedData }), stage);
    const products = path.join(derivedData, 'Build/Products/Release-iphoneos');
    const apps = (await fs.readdir(products)).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('Xcode did not produce exactly one Release iPhone app.');
    const payload = path.join(output, 'packaging/Payload');
    await fs.mkdir(payload, { recursive: true });
    const app = path.join(payload, apps[0]);
    await run('copy-app-payload', 'ditto', [path.join(products, apps[0]), app], stage);
    const info = await run('built-info-plist', 'plutil', ['-convert', 'xml1', '-o', '-', path.join(app, 'Info.plist')], stage);
    const plistModule = require('@expo/plist');
    const plist = plistModule.default ?? plistModule;
    const metadata = assertUnsignedAppMetadata(plist.parse(info.stdout), JSON.parse(await fs.readFile(path.join(stage, 'app.json'), 'utf8')).expo);
    report.app = metadata;
    const arch = await run('app-architectures', 'lipo', ['-archs', path.join(app, metadata.executable)], stage);
    if (arch.stdout.trim() !== 'arm64') throw new Error('Expected an arm64 device executable; simulator and mixed binaries are not packaged.');
    report.architecture = 'arm64';
    let files = await listRegularFiles(app);
    if (files.some((file) => /\.mobileprovision$|\.(?:p12|pem|key)$/i.test(file))) throw new Error('Unsigned build unexpectedly contains provisioning or key material.');
    // Strip vendor/ad-hoc signatures from any embedded Mach-O binary as well as
    // the main executable. This never creates or accesses a signing identity.
    const macho = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
    let index = 0;
    for (const file of files) {
      const target = path.join(app, ...file.split('/'));
      const handle = await fs.open(target, 'r');
      const magic = Buffer.alloc(4);
      const read = await handle.read(magic, 0, 4, 0);
      await handle.close();
      if (read.bytesRead !== 4 || !macho.has(magic.readUInt32BE(0))) continue;
      index += 1;
      const signed = await run(`signature-check-${index}`, 'codesign', ['-d', target], stage, { allowFailure: true });
      if (signed.exitCode === 0) {
        await run(`remove-signature-${index}`, 'codesign', ['--remove-signature', target], stage);
        const verify = await run(`unsigned-check-${index}`, 'codesign', ['-d', target], stage, { allowFailure: true });
        if (verify.exitCode === 0 || !/not signed at all/i.test(verify.stderr)) throw new Error('Cannot verify that an embedded Mach-O executable is unsigned after signature removal.');
      } else if (!/not signed at all/i.test(signed.stderr)) throw new Error('codesign could not confirm the signing state of an embedded Mach-O executable.');
    }
    const signatureDirectories = new Set(files.flatMap((file) => {
      const parts = file.split('/');
      const marker = parts.indexOf('_CodeSignature');
      return marker < 0 ? [] : [parts.slice(0, marker + 1).join('/')];
    }));
    const canonicalApp = await fs.realpath(app);
    for (const relative of signatureDirectories) {
      const target = path.join(canonicalApp, ...relative.split('/'));
      const canonicalTarget = await fs.realpath(target).catch(() => null);
      if (!canonicalTarget) continue;
      const difference = path.relative(canonicalApp, canonicalTarget);
      if (!difference || difference === '..' || difference.startsWith(`..${path.sep}`) || path.isAbsolute(difference)) throw new Error('Signature cleanup escaped the isolated app payload.');
      await fs.rm(canonicalTarget, { recursive: true });
    }
    files = await listRegularFiles(app);
    const privacy = [];
    for (const file of files.filter((file) => file.endsWith('PrivacyInfo.xcprivacy'))) {
      const content = await run(`privacy-${privacy.length + 1}`, 'plutil', ['-convert', 'xml1', '-o', '-', path.join(app, ...file.split('/'))], stage);
      const manifest = plist.parse(content.stdout);
      if (manifest.NSPrivacyTracking === true) throw new Error('A built privacy manifest unexpectedly enables tracking.');
      privacy.push({ path: file, content: manifest });
    }
    if (!privacy.length) throw new Error('No privacy manifest was found in the built app. Review the pod aggregation.');
    report.privacyManifests = privacy;
    const js = await fs.readFile(path.join(app, 'main.jsbundle'));
    const jsText = js.toString('utf8');
    if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|data:(?:image|video)\/[\w.+-]+;base64,[A-Za-z0-9+/]{64,}|\b(?:heightCm|weightKg):\d+/.test(jsText)) throw new Error('The native Release bundle contains unreviewed credentials, media, or body measurements.');
    report.javascript = { bytes: js.length, sha256: sha256(js) };
    const ipaName = `youjie-${metadata.version}-${metadata.buildNumber}-ios-arm64-UNSIGNED.ipa`;
    const ipa = path.join(output, ipaName);
    await run('package-unsigned-ipa', 'ditto', ['-c', '-k', '--norsrc', '--keepParent', payload, ipa], stage);
    const bytes = await fs.readFile(ipa);
    const audit = await auditUnsignedIpa(bytes, { appName: apps[0], executable: metadata.executable, expectedBundleHash: report.javascript.sha256 });
    const manifest = {
      signingStatus: 'UNSIGNED', directlyInstallable: false, requiresResigning: true,
      provisioningProfileIncluded: false, appleCredentialsUsed: false,
      app: metadata, architecture: 'arm64', ipa: ipaName, bytes: bytes.length, sha256: sha256(bytes),
      sourceFileCount: source.entries.length, toolchain: report.toolchain, privacyManifests: privacy,
      javascript: report.javascript, archiveAudit: audit,
      instructions: 'Re-sign on the owner\'s Windows computer using their own Apple account and an appropriate sideloading tool. This unsigned IPA cannot be installed directly, and no device test has been performed.',
    };
    await fs.writeFile(path.join(output, `${ipaName}.sha256`), `${manifest.sha256}  ${ipaName}\n`, 'utf8');
    await fs.writeFile(path.join(output, 'unsigned-ipa-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    report.status = 'unsigned_ipa_produced';
    report.ipa = { path: ipaName, bytes: bytes.length, sha256: manifest.sha256, audit };
    report.deviceTest = 'not_run';
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(`UNSIGNED IPA: ${ipa}`);
    console.log('This file requires owner-side signing before installation. No Apple account or signing secret was used.');
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    await save();
    throw error;
  }
}

const invokedDirectly = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try { await buildUnsignedIpa(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
