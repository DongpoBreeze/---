import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import JSZip from 'jszip';
import YAML from 'yaml';
import { minimatch } from 'minimatch';
import { emptyData } from '../src/types.ts';
import { canonicalSourcePath, copySafeSource, createSourceArchive, expectedEasIgnore, inspectSource, IOS_SOURCE_FILES, iosBuildEnvironment, isAllowedSourcePath, listRegularFiles } from './ios-source-policy.mjs';
import { applyExpoSwift62Backport, assertUnsignedAppMetadata, auditUnsignedIpa, EXPO_SWIFT62_BACKPORT, readIosSwiftRequirements, swiftToolsMinimum, unsignedXcodeArguments, validateUnsignedToolchain } from './ios-unsigned.mjs';
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

async function backportFixture(t) {
  const result = await fixture(t);
  const packageRoot = path.join(result.source, 'node_modules/expo-modules-jsi');
  for (const entry of EXPO_SWIFT62_BACKPORT.files) await fs.mkdir(path.dirname(path.join(packageRoot, ...entry.path.split('/'))), { recursive: true });
  for (const file of ['package.json', ...EXPO_SWIFT62_BACKPORT.files.filter((entry) => entry.beforeSha256 !== null).map((entry) => entry.path)]) {
    const target = path.join(packageRoot, ...file.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'node_modules/expo-modules-jsi', ...file.split('/')), target);
  }
  return { ...result, packageRoot };
}

async function backportBytes(packageRoot) {
  return Promise.all(EXPO_SWIFT62_BACKPORT.files.map((file) => fs.readFile(path.join(packageRoot, ...file.path.split('/'))).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })));
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
  const compatible = { xcodeVersion: '26.3', sdkVersion: '26.2', swiftVersion: '6.2.3', minimumXcode: '16.1', minimumIos: '16.4', minimumSwift: '6.2' };
  assert.deepEqual(validateUnsignedToolchain(compatible), compatible);
  assert.throws(() => validateUnsignedToolchain({ ...compatible, xcodeVersion: '15.4' }), /older than/);
  assert.throws(() => validateUnsignedToolchain({ ...compatible, sdkVersion: '15.5' }), /cannot build/);
  assert.throws(() => validateUnsignedToolchain({ ...compatible, xcodeVersion: 'unknown' }), /Cannot determine/);
  assert.throws(() => validateUnsignedToolchain({ ...compatible, swiftVersion: undefined }), /Cannot determine/);
  const args = unsignedXcodeArguments({ workspace: '/tmp/YouJie.xcworkspace', scheme: 'YouJie', derivedData: '/tmp/derived' });
  assert.ok(args.includes('Release'));
  assert.ok(args.includes('iphoneos'));
  assert.ok(args.includes('generic/platform=iOS'));
  assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO'));
  assert.ok(args.includes('CODE_SIGNING_REQUIRED=NO'));
  assert.equal(args.some((argument) => argument === '-allowProvisioningUpdates' || argument === '-allowProvisioningDeviceRegistration'), false);
});

test('the locked Apple Swift packages reject Xcode 16.4 despite meeting React Native\'s minimum Xcode', async () => {
  assert.equal(swiftToolsMinimum('// swift-tools-version: 6.2\nimport PackageDescription\n'), '6.2');
  assert.equal(swiftToolsMinimum('// swift-tools-version: 6.2.1\r\n'), '6.2.1');
  assert.throws(() => swiftToolsMinimum('import PackageDescription\n'), /Cannot determine/);
  const requirements = await readIosSwiftRequirements(root);
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(requirements.minimumSwift, '6.2');
  assert.equal(requirements.manifests.length, 3);
  for (const entry of requirements.manifests) {
    assert.equal(entry.version, lock.packages[`node_modules/${entry.package}`].version);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  for (const name of ['expo-modules-jsi', '@expo/expo-modules-macros-plugin']) assert.equal(requirements.manifests.find((entry) => entry.package === name).minimumSwift, '6.2');
  const failingRunner = { xcodeVersion: '16.4', sdkVersion: '18.5', swiftVersion: '6.1.0', minimumXcode: '16.1', minimumIos: '16.4', minimumSwift: requirements.minimumSwift };
  assert.throws(() => validateUnsignedToolchain(failingRunner), /Swift 6\.1\.0.*require Swift tools 6\.2/);
  assert.equal(validateUnsignedToolchain({ ...failingRunner, xcodeVersion: '26.3', sdkVersion: '26.2', swiftVersion: '6.2.3' }).minimumSwift, '6.2');
  assert.throws(() => validateUnsignedToolchain({ ...failingRunner, xcodeVersion: '26.3' }), /provides Swift 6\.1\.0/);
});

test('the Swift 6.2 backport exactly matches all three official SDK 57 production files without changing installed dependencies', async (t) => {
  const installedPackage = path.join(root, 'node_modules/expo-modules-jsi');
  const installedBefore = await backportBytes(installedPackage);
  assert.deepEqual(installedBefore.map((bytes) => bytes === null ? null : sha256(bytes)), EXPO_SWIFT62_BACKPORT.files.map((file) => file.beforeSha256));
  const { source, packageRoot } = await backportFixture(t);
  const result = await applyExpoSwift62Backport(source);
  assert.equal(result.status, 'applied');
  assert.equal(result.package, 'expo-modules-jsi');
  assert.equal(result.version, '57.1.1');
  assert.equal(result.upstreamPullRequest, 'https://github.com/expo/expo/pull/51040');
  assert.equal(result.upstreamCommit, 'd50bac42ff61d70fba771efd7056f09565f86b03');
  assert.equal(result.sdk57Commit, 'bd2ade709029be3fbb44b6ba49bff32b02e66c81');
  assert.equal(result.scope, 'isolated-build-dependency-copy');
  assert.deepEqual(result.files, EXPO_SWIFT62_BACKPORT.files.map((file) => ({ ...file, path: 'node_modules/expo-modules-jsi/' + file.path })));
  const [headerBytes, runtimeBytes, wrapperBytes] = await backportBytes(packageRoot);
  assert.deepEqual([headerBytes, runtimeBytes, wrapperBytes].map(sha256), EXPO_SWIFT62_BACKPORT.files.map((file) => file.afterSha256));
  const header = headerBytes.toString('utf8'), runtime = runtimeBytes.toString('utf8');
  assert.equal((header.match(/static RuntimeScheduler \*create\(/g) ?? []).length, 2);
  assert.equal((header.match(/noexcept SWIFT_RETURNS_RETAINED/g) ?? []).length, 2);
  assert.equal(/SWIFT_RETURNS_RETAINED RuntimeScheduler\(/.test(header), false);
  assert.match(header, /SWIFT_SHARED_REFERENCE\(retainRuntimeScheduler, releaseRuntimeScheduler\)/);
  assert.match(header, /refCount\.fetch_add\(1, std::memory_order_relaxed\)/);
  assert.match(header, /refCount\.fetch_sub\(1, std::memory_order_acq_rel\)/);
  assert.equal((runtime.match(/expo\.RuntimeScheduler\.create\(/g) ?? []).length, 4);
  assert.equal(/expo\.RuntimeScheduler\(/.test(runtime), false);
  for (const [name, count] of [['thisPtr', 2], ['argumentsPtr', 2], ['resultPtr', 3]]) {
    assert.equal(runtime.split('let ' + name + ' = UncheckedSendable(' + name + ')').length - 1, count);
  }
  assert.equal((runtime.match(/writeJSIValue\(to: resultPtr\.value\)/g) ?? []).length, 3);
  assert.match(wrapperBytes.toString('utf8'), /internal struct UncheckedSendable<Value>: @unchecked Sendable/);
  assert.deepEqual(await backportBytes(installedPackage), installedBefore);
  assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version, '57.1.1');
  assert.equal(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'), await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const mtimes = await Promise.all(result.files.map((file) => fs.stat(path.join(source, ...file.path.split('/'))).then((info) => info.mtimeMs)));
  assert.equal((await applyExpoSwift62Backport(source)).status, 'already_applied');
  assert.deepEqual(await Promise.all(result.files.map((file) => fs.stat(path.join(source, ...file.path.split('/'))).then((info) => info.mtimeMs))), mtimes);
});

test('any changed preimage or partially applied backport rejects the entire operation before writing', async (t) => {
  for (const file of EXPO_SWIFT62_BACKPORT.files) {
    const { source, packageRoot } = await backportFixture(t);
    await fs.appendFile(path.join(packageRoot, ...file.path.split('/')), '\n// Controlled fixture preimage drift.\n');
    const before = await backportBytes(packageRoot);
    await assert.rejects(applyExpoSwift62Backport(source), /preimage drift or partial application/);
    assert.deepEqual(await backportBytes(packageRoot), before, file.path);
  }
  const { source, packageRoot } = await backportFixture(t);
  const originals = await backportBytes(packageRoot);
  await applyExpoSwift62Backport(source);
  await fs.writeFile(path.join(packageRoot, ...EXPO_SWIFT62_BACKPORT.files[1].path.split('/')), originals[1]);
  const partial = await backportBytes(packageRoot);
  await assert.rejects(applyExpoSwift62Backport(source), /preimage drift or partial application/);
  assert.deepEqual(await backportBytes(packageRoot), partial);
});

test('the backport refuses a different installed or locked version, linked dependency trees, and the caller source tree', async (t) => {
  for (const target of ['installed', 'lock']) {
    const { source, packageRoot } = await backportFixture(t);
    const file = target === 'installed' ? path.join(packageRoot, 'package.json') : path.join(source, 'package-lock.json');
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    if (target === 'installed') json.version = '57.1.2';
    else json.packages['node_modules/expo-modules-jsi'].version = '57.1.2';
    await fs.writeFile(file, JSON.stringify(json));
    const before = await backportBytes(packageRoot);
    await assert.rejects(applyExpoSwift62Backport(source), /only to locked expo-modules-jsi@57\.1\.1/);
    assert.deepEqual(await backportBytes(packageRoot), before);
  }
  const { directory, source, packageRoot } = await backportFixture(t);
  const linkedPackage = path.join(directory, 'outside-installed-package');
  await fs.rename(packageRoot, linkedPackage);
  await fs.symlink(linkedPackage, packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await backportBytes(linkedPackage);
  await assert.rejects(applyExpoSwift62Backport(source), /must not contain links/);
  assert.deepEqual(await backportBytes(linkedPackage), before);
  await assert.rejects(applyExpoSwift62Backport(root), /requires an isolated build dependency copy/);
});

test('only the Mac unsigned build copies dependencies and applies the backport before CocoaPods', async () => {
  const script = await fs.readFile(path.join(root, 'scripts/ios-unsigned.mjs'), 'utf8');
  const build = script.indexOf('async function buildUnsignedIpa()');
  const mac = script.indexOf("if (process.platform !== 'darwin')", build);
  const copy = script.indexOf("await run('copy-locked-build-dependencies', 'ditto'", build);
  const patch = script.indexOf('report.nativeDependencyBackport = await applyExpoSwift62Backport(stage)', build);
  const pods = script.indexOf("await run('pod-install'", build);
  assert.ok(build >= 0 && mac > build && copy > mac && patch > copy && pods > patch);
  assert.equal(script.includes('await fs.symlink('), false);
  assert.match(script, /nativeDependencyBackport: report\.nativeDependencyBackport/);
  assert.equal((await fs.readFile(path.join(root, 'scripts/ios-prepare.mjs'), 'utf8')).includes('applyExpoSwift62Backport'), false);
  if (process.platform !== 'darwin') {
    const result = spawnSync(process.execPath, ['scripts/ios-unsigned.mjs'], { cwd: root, env: iosBuildEnvironment(), encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /macOS and Xcode/);
  }
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
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 2);
  const checkout = checkouts[0];
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['sparse-checkout-cone-mode'], false);
  assert.equal(checkout.with['sparse-checkout'].trim(), '/scripts/ios-source-policy.mjs');
  const policy = steps.findIndex((step) => step.id === 'source-policy');
  const expand = steps.indexOf(checkouts[1]);
  const stage = steps.findIndex((step) => step.run?.includes('ios-source-policy.mjs --stage'));
  const install = steps.findIndex((step) => step.run?.includes('npm ci'));
  const build = steps.findIndex((step) => step.run?.includes('ios-unsigned.mjs --output'));
  assert.ok(policy >= 0 && expand > policy && stage > expand && install > stage && build > install);
  assert.equal(checkouts[1].with.path, 'reviewed-client');
  assert.equal(checkouts[1].with['persist-credentials'], false);
  assert.equal(checkouts[1].with['sparse-checkout-cone-mode'], false);
  assert.equal(checkouts[1].with['sparse-checkout'], '${{ steps.source-policy.outputs.paths }}');
  assert.equal(steps[stage]['working-directory'], 'reviewed-client');
  assert.equal(workflow.jobs.build.env.EXPO_NO_DOTENV, '1');
  assert.equal(workflow.jobs.build.env.EXPO_NO_CLIENT_ENV_VARS, '1');
  const select = steps.findIndex((step) => step.run?.includes('sudo xcode-select --switch'));
  assert.ok(select > install && select < build);
  assert.match(steps[select].run, /xcode_developer=\/Applications\/Xcode_26\.3\.app\/Contents\/Developer/);
  assert.match(steps[select].run, /if \[\[ ! -d "\$xcode_developer" \]\]/);
  for (const command of ['xcode-select --print-path', 'xcodebuild -version', 'xcrun --sdk iphoneos --show-sdk-version', 'xcrun swift --version']) assert.ok(steps[select].run.includes(command));
  const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    for (const member of upload.with.path.trim().split('\n')) {
      assert.match(member, /\/ios-unsigned-build\/(?:\*-UNSIGNED\.ipa(?:\.sha256)?|unsigned-ipa-manifest\.json|build-summary\.json|logs\/\*\.log)$/);
    }
  }
  assert.equal(/secrets\.|EXPO_TOKEN|APPLE_ID|APPLE_PASSWORD|allowProvisioningUpdates|allowProvisioningDeviceRegistration/.test(text), false);
});

test('private partial-clone checkout expands through the authenticated action, with only reviewed paths passed as step output', async () => {
  const workflow = YAML.parse(await fs.readFile(path.join(root, '.github/workflows/ios-unsigned.yml'), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const output = steps.find((step) => step.id === 'source-policy');
  assert.ok(output);
  assert.match(output.run, />> "\$GITHUB_OUTPUT"/);
  const script = /<<'NODE'[^\n]*\n([\s\S]+)\nNODE\s*$/.exec(output.run)?.[1];
  assert.ok(script, 'The reviewed-path output must be an inspectable Node script.');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, env: iosBuildEnvironment(), encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.shift(), 'paths<<HEALTH_COMPASS_IOS_SOURCE_PATHS');
  assert.equal(lines.pop(), 'HEALTH_COMPASS_IOS_SOURCE_PATHS');
  assert.deepEqual(lines, IOS_SOURCE_FILES.map((file) => '/' + file));
  for (const step of steps.filter((step) => typeof step.run === 'string')) {
    // Regression: `git sparse-checkout set` after persist-credentials:false can
    // fetch missing promisor blobs without auth and fail in a private repo.
    assert.equal(/(?:spawnSync\s*\(\s*['"]git['"]|\bgit\s+(?:sparse-checkout|fetch|checkout)\b)/.test(step.run), false, step.name);
    assert.equal(/github\.token|secrets\.|http\.extraheader|GIT_ASKPASS|GITHUB_TOKEN|GH_TOKEN/.test(step.run), false, step.name);
  }
  const expanded = steps.find((step) => step.uses?.startsWith('actions/checkout@') && step.with?.['sparse-checkout'] === '${{ steps.source-policy.outputs.paths }}');
  assert.ok(expanded, 'The checkout action itself must hydrate the reviewed files while it has its temporary authorization.');
  assert.equal(expanded.with['persist-credentials'], false);
  assert.equal(expanded.with.path, 'reviewed-client');
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
