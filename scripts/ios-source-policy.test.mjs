import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import JSZip from 'jszip';
import YAML from 'yaml';
import { minimatch } from 'minimatch';
import { emptyData } from '../src/types.ts';
import { canonicalSourcePath, copySafeSource, createSourceArchive, expectedEasIgnore, inspectSource, IOS_SOURCE_FILES, iosBuildEnvironment, isAllowedSourcePath, listRegularFiles } from './ios-source-policy.mjs';
import { assertUnsignedAppMetadata, auditUnsignedIpa, unsignedXcodeArguments, validateUnsignedToolchain } from './ios-unsigned.mjs';
import { sha256 } from './ios-source-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'health-compass-ios-policy-'));
  const canonical = await fs.realpath(directory);
  const expectedParent = await fs.realpath(os.tmpdir());
  t.after(async () => {
    // Delete only the exact temporary test directory created above. Node does not
    // follow the deliberately malicious source junctions during recursive rm.
    assert.equal(path.dirname(canonical), expectedParent);
    assert.ok(path.basename(canonical).startsWith('health-compass-ios-policy-'));
    await fs.rm(canonical, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source');
  await copySafeSource(root, source);
  return { directory, source };
}

test('fresh installations contain no body measurements, health entries, or AI settings', () => {
  assert.deepEqual(emptyData(), { version: 1, profile: {}, meals: [], trainings: [], sleeps: [], exerciseTemplates: [], summaries: [], sourceVersion: 0 });
  const first = emptyData();
  first.profile.heightCm = 199;
  assert.deepEqual(emptyData().profile, {});
});

test('path policy rejects traversal, alternate streams, absolute paths, aliases, and unknown files', () => {
  assert.equal(isAllowedSourcePath('src/ui/me.tsx'), true);
  assert.equal(isAllowedSourcePath('src\\ui\\me.tsx'), true);
  const forbidden = [
    '../App.tsx', 'src/../App.tsx', 'src\\ui\\..\\..\\App.tsx', './App.tsx',
    '/App.tsx', 'C:\\App.tsx', '\\\\server\\App.tsx', 'App.tsx:credentials', 'App.tsx\0',
    'src//ui/me.tsx', 'src/ui/me.tsx/', 'app.tsx', 'src/ui/new-feature.tsx',
    'src/private-ai-settings.ts', 'src/ui/.env', 'src/ui/backup.json', 'assets/private.png',
    'data/nutrition/private-settings.json', 'data/validation/photo.jpg', 'server/data/state.sqlite',
    '.env.production', '.expo/settings.json', '.codex/config.toml', 'credentials.json',
    'certs/distribution.p12', 'ios/user.mobileprovision', 'artifacts/private-backup.zip',
  ];
  for (const file of forbidden) assert.equal(isAllowedSourcePath(file), false, file);
  assert.equal(canonicalSourcePath(undefined), null);
});

test('gitignore semantics enforce the EAS source allowlist, including nested and dotfile canaries', async () => {
  const rules = await fs.readFile(path.join(root, '.easignore'), 'utf8');
  assert.equal(rules.replaceAll('\r\n', '\n'), expectedEasIgnore());
  const matcher = ignore().add(rules);
  for (const file of IOS_SOURCE_FILES) assert.equal(matcher.ignores(file), false, file);
  for (const file of [
    'server/data/health.json', 'server/index.mjs', 'data/validation/photo.jpg',
    'data/validation/nested/original.heic', 'data/nutrition/ai-key.json',
    'artifacts/source/src/ui/me.tsx', 'src/ui/.env.local', 'src/ui/nested/private.ts',
    'src/ui/unknown.tsx', 'src/private-config.ts', 'assets/camera-roll.png',
    '.env', '.env.server.local', '.expo/state.json', '.codex/auth.json', '.git/config',
    'unknown-root.ts', 'package.json.bak', 'credentials.json', 'node_modules/local-private/file.ts',
    '.github/workflows/private.yml',
    'ios/LocalSettings.plist', 'backups/health-compass.zip', 'keys/ios.p12',
  ]) assert.equal(matcher.ignores(file), true, file);
});

test('child builds never read developer secret environment values and cannot inherit dotenv or Node hooks', () => {
  const input = { Path: '/safe/bin', TEMP: '/safe/tmp', NODE_OPTIONS: '--require private-hook.cjs', EXPO_NO_DOTENV: '0', EXPO_NO_CLIENT_ENV_VARS: '0' };
  for (const name of ['EXPO_PUBLIC_AI_API_KEY', 'EXPO_PUBLIC_AI_BASE_URL', 'OPENAI_API_KEY', 'EXPO_TOKEN', 'npm_config__authToken']) {
    Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`Secret ${name} was read.`); } });
  }
  const result = iosBuildEnvironment(input);
  assert.equal(result.Path, '/safe/bin');
  assert.equal(result.EXPO_NO_DOTENV, '1');
  assert.equal(result.EXPO_NO_CLIENT_ENV_VARS, '1');
  assert.equal(result.NODE_ENV, 'production');
  assert.equal(result.CI, '1');
  for (const name of ['NODE_OPTIONS', 'EXPO_PUBLIC_AI_API_KEY', 'EXPO_PUBLIC_AI_BASE_URL', 'OPENAI_API_KEY', 'EXPO_TOKEN', 'npm_config__authToken']) assert.equal(Object.hasOwn(result, name), false);
});

test('source staging and the reopened ZIP exclude injected personal files and preserve reviewed runtime code', async (t) => {
  const { directory, source } = await fixture(t);
  const canary = `controlled-personal-data-${randomUUID()}`;
  for (const file of ['server/data/records.json', 'data/validation/nested/photo.jpg', 'src/ui/private.tsx', 'assets/private.png', '.env', '.expo/settings.json', '.codex/config.toml', 'credentials.json', 'backups/export.zip']) {
    const target = path.join(source, ...file.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, canary);
  }
  const safe = path.join(directory, 'safe');
  await copySafeSource(source, safe);
  assert.deepEqual(await listRegularFiles(safe), IOS_SOURCE_FILES);
  await assert.rejects(createSourceArchive(source, path.join(directory, 'unsafe.zip')), /unapproved files/);
  const output = path.join(directory, 'source.zip');
  const audit = await createSourceArchive(safe, output);
  assert.equal(audit.verifiedMembers, IOS_SOURCE_FILES.length);
  const zip = await JSZip.loadAsync(await fs.readFile(output), { checkCRC32: true });
  for (const [name, member] of Object.entries(zip.files)) {
    assert.ok(isAllowedSourcePath(name));
    assert.equal((await member.async('nodebuffer')).includes(Buffer.from(canary)), false, name);
    assert.equal((member.unixPermissions & 0o170000), 0o100000);
  }
  assert.equal(await zip.file('App.tsx').async('string'), await fs.readFile(path.join(root, 'App.tsx'), 'utf8'));
});

test('source staging refuses junctions into an outside private folder even under an approved source path', async (t) => {
  const { directory, source } = await fixture(t);
  const privateDirectory = path.join(directory, 'private');
  await fs.mkdir(privateDirectory);
  await fs.writeFile(path.join(privateDirectory, 'me.tsx'), 'private data must never be read');
  const ui = path.join(source, 'src/ui');
  const safeUi = path.join(source, 'src/ui-original');
  await fs.rename(ui, safeUi);
  await fs.symlink(privateDirectory, ui, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copySafeSource(source, path.join(directory, 'rejected')), /Source links are not allowed/);
});

test('source staging refuses client environment injection and does not disclose a credential-shaped literal', async (t) => {
  const { directory, source } = await fixture(t);
  const app = path.join(source, 'App.tsx');
  const original = await fs.readFile(app, 'utf8');
  await fs.writeFile(app, original + '\nconst settings = process.env.EXPO_PUBLIC_AI_API_KEY;\n');
  await assert.rejects(copySafeSource(source, path.join(directory, 'env-rejected')), /client build environment access/);
  const secret = `sk-${'ControlledFixtureOnly'.repeat(3)}`;
  await fs.writeFile(app, original + `\nconst apiKey = '${secret}';\n`);
  await assert.rejects(inspectSource(source), (error) => {
    assert.match(error.message, /credential/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('private runtime configuration and prefilled body measurements fail closed', async (t) => {
  const { source } = await fixture(t);
  const config = path.join(source, 'app.json');
  const original = JSON.parse(await fs.readFile(config, 'utf8'));
  await fs.writeFile(config, JSON.stringify({ ...original, expo: { ...original.expo, extra: { aiBaseUrl: 'https://private.example.test' } } }));
  await assert.rejects(inspectSource(source), /private runtime settings/);
  await fs.writeFile(config, JSON.stringify(original));
  const app = path.join(source, 'App.tsx');
  await fs.appendFile(app, '\nconst leakedProfile = { heightCm: 173, weightKg: 72 };\n');
  await assert.rejects(inspectSource(source), /prefilled body measurement/);
});

test('the unsigned native build requires a compatible Xcode/SDK and uses device Release signing exclusions', () => {
  assert.deepEqual(validateUnsignedToolchain({ xcodeVersion: '16.4', sdkVersion: '18.5', minimumXcode: '16.1', minimumIos: '16.4' }), { xcodeVersion: '16.4', sdkVersion: '18.5', minimumXcode: '16.1', minimumIos: '16.4' });
  assert.throws(() => validateUnsignedToolchain({ xcodeVersion: '15.4', sdkVersion: '17.5', minimumXcode: '16.1', minimumIos: '16.4' }), /older than/);
  assert.throws(() => validateUnsignedToolchain({ xcodeVersion: '16.4', sdkVersion: '15.5', minimumXcode: '16.1', minimumIos: '16.4' }), /cannot build/);
  assert.throws(() => validateUnsignedToolchain({ xcodeVersion: 'unknown', sdkVersion: '18.5', minimumXcode: '16.1', minimumIos: '16.4' }), /Cannot determine/);
  const args = unsignedXcodeArguments({ workspace: '/tmp/YouJie.xcworkspace', scheme: 'YouJie', derivedData: '/tmp/derived' });
  assert.ok(args.includes('Release'));
  assert.ok(args.includes('iphoneos'));
  assert.ok(args.includes('generic/platform=iOS'));
  assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO'));
  assert.ok(args.includes('CODE_SIGNING_REQUIRED=NO'));
  assert.equal(args.some((argument) => argument === '-allowProvisioningUpdates' || argument === '-allowProvisioningDeviceRegistration'), false);
});

test('the cloud workflow builds only on explicit dispatch or the dedicated unsigned branch and stages exact reviewed files', async () => {
  const text = await fs.readFile(path.join(root, '.github/workflows/ios-unsigned.yml'), 'utf8');
  const workflow = YAML.parse(text);
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['codex/ios-unsigned-*'] });
  const pattern = workflow.on.push.branches[0];
  for (const branch of ['codex/ios-unsigned-20261022', 'codex/ios-unsigned-local-build']) assert.equal(minimatch(branch, pattern), true, branch);
  for (const branch of ['main', 'master', 'codex/health-recording-updates', 'codex/ios-unsigned', 'feature/ios', 'codex/ios-unsigned-release/nested']) assert.equal(minimatch(branch, pattern), false, branch);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.build['runs-on'], 'macos-15');
  const steps = workflow.jobs.build.steps;
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['sparse-checkout-cone-mode'], false);
  assert.equal(checkout.with['sparse-checkout'].trim(), '/scripts/ios-source-policy.mjs');
  const expand = steps.findIndex((step) => step.run?.includes("['sparse-checkout', 'set', '--no-cone', '--stdin']"));
  const stage = steps.findIndex((step) => step.run?.includes('ios-source-policy.mjs --stage'));
  const install = steps.findIndex((step) => step.run?.includes('npm ci'));
  const build = steps.findIndex((step) => step.run?.includes('ios-unsigned.mjs --output'));
  assert.ok(expand >= 0 && stage > expand && install > stage && build > install);
  assert.equal(workflow.jobs.build.env.EXPO_NO_DOTENV, '1');
  assert.equal(workflow.jobs.build.env.EXPO_NO_CLIENT_ENV_VARS, '1');
  const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    for (const member of upload.with.path.trim().split('\n')) {
      assert.match(member, /\/ios-unsigned-build\/(?:\*-UNSIGNED\.ipa(?:\.sha256)?|unsigned-ipa-manifest\.json|build-summary\.json|logs\/\*\.log)$/);
    }
  }
  assert.equal(/secrets\.|EXPO_TOKEN|APPLE_ID|APPLE_PASSWORD|allowProvisioningUpdates|allowProvisioningDeviceRegistration/.test(text), false);
});

test('compiled iOS metadata must preserve the app identity, camera/photo needs, and HTTPS policy', () => {
  const expected = { name: '有节', version: '0.1.3', ios: { bundleIdentifier: 'com.healthcompass.app', buildNumber: '1' } };
  const plist = { CFBundleDisplayName: '有节', CFBundleIdentifier: 'com.healthcompass.app', CFBundleShortVersionString: '0.1.3', CFBundleVersion: '1', CFBundleExecutable: 'YouJie', MinimumOSVersion: '16.4', NSCameraUsageDescription: '拍照', NSPhotoLibraryUsageDescription: '选图与视频', NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } };
  assert.equal(assertUnsignedAppMetadata(plist, expected).minimumIos, '16.4');
  assert.throws(() => assertUnsignedAppMetadata({ ...plist, CFBundleDisplayName: 'Unexpected' }, expected), /does not match/);
  assert.throws(() => assertUnsignedAppMetadata({ ...plist, NSMicrophoneUsageDescription: 'Unused' }, expected), /unrequested permission/);
  assert.throws(() => assertUnsignedAppMetadata({ ...plist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }, expected), /arbitrary network/);
  assert.throws(() => assertUnsignedAppMetadata({ ...plist, MinimumOSVersion: '15.1' }, expected), /deployment target/);
});

test('unsigned IPA verification requires one complete payload with the verified fresh bundle and no signing or personal files', async () => {
  const bundle = Buffer.from('controlled-release-js-fixture');
  const makeZip = async (extra) => {
    const zip = new JSZip();
    zip.file('Payload/YouJie.app/Info.plist', '<plist/>');
    zip.file('Payload/YouJie.app/YouJie', Buffer.from('controlled-executable-fixture'));
    zip.file('Payload/YouJie.app/main.jsbundle', bundle);
    if (extra) zip.file(extra, 'controlled-excluded-fixture');
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  const expected = { appName: 'YouJie.app', executable: 'YouJie', expectedBundleHash: sha256(bundle) };
  assert.equal((await auditUnsignedIpa(await makeZip(), expected)).status, 'passed');
  for (const file of ['Payload/YouJie.app/embedded.mobileprovision', 'Payload/YouJie.app/_CodeSignature/CodeResources', 'Payload/YouJie.app/private-photo.jpg', 'Payload/YouJie.app/health.sqlite', 'Payload/YouJie.app/.env.local', 'Payload/YouJie.app/private/ai-settings.json', 'Payload/Other.app/Info.plist', 'source/.env']) {
    await assert.rejects(auditUnsignedIpa(await makeZip(file), expected), /signature|provisioning|personal|outside|private configuration/);
  }
  await assert.rejects(auditUnsignedIpa(await makeZip(), { ...expected, expectedBundleHash: 'stale-bundle-hash' }), /freshly built/);
});
