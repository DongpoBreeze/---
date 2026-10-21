import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareLocalCodex } from '../server/local-codex.mjs';

try {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const { clientEnv } = await prepareLocalCodex({ projectRoot });
  const child = spawn(process.execPath, ['--dns-result-order=ipv4first', 'node_modules/expo/bin/cli', 'start', '--web', '--localhost', '--port', '8081', '--max-workers', '2'], {
    cwd: projectRoot, stdio: 'inherit', env: { ...process.env, ...clientEnv, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1' },
  });
  child.on('error', () => { console.error('Cannot start the local preview.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  process.once('SIGTERM', () => child.kill());
  process.once('SIGINT', () => child.kill());
} catch {
  console.error('Cannot prepare the local Codex preview. Start npm run server:codex to check configuration.');
  process.exitCode = 1;
}
