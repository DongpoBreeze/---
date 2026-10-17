import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = 3000;
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function isPortServing(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startExpo() {
  console.log(`Starting Expo web server on http://localhost:${PORT} ...`);
  const child = spawn(
    process.execPath,
    ['node_modules/expo/bin/cli', 'start', '--web', '--port', String(PORT), '--max-workers', '2'],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', CI: '0' },
    },
  );
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  process.once('SIGINT', () => child.kill('SIGINT'));
}

if (await isPortServing(PORT)) {
  console.log(`Waiting on http://localhost:${PORT}`);
  console.log(`Logs for your project will appear below.`);
  const timer = setInterval(async () => {
    if (!(await isPortServing(PORT))) {
      clearInterval(timer);
      startExpo();
    }
  }, 3000);
  process.once('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.once('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
} else {
  startExpo();
}
