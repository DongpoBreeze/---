import { fileURLToPath } from 'node:url';
import { createAppServer } from './index.mjs';
import { prepareLocalCodex, LOCAL_MODEL, LOCAL_REASONING } from './local-codex.mjs';

try {
  const { config, pricingVerified } = await prepareLocalCodex({ projectRoot: fileURLToPath(new URL('../', import.meta.url)) });
  const { server, ledger } = createAppServer({ config, onUpstreamError: (diagnostic) => {
    console.warn(`Upstream failure: HTTP ${diagnostic.status}; category=${diagnostic.category}; fields=${diagnostic.fieldHints.join(',') || 'unknown'}`);
  } });
  server.once('error', () => {
    ledger.close();
    console.error('Cannot start local AI gateway. Check whether port 8787 is already in use.');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Local AI gateway: http://${config.host}:${config.port} (${LOCAL_MODEL}, ${LOCAL_REASONING})`);
    console.log(pricingVerified ? 'Provider pricing marked as verified in local settings.' : 'Provider pricing is unverified. Local reservations are not a provider billing guarantee.');
  });
  const stop = () => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  // Never echo parser or network exceptions containing the original Codex configuration.
  console.error(error.message.startsWith('Invalid ') || error.message.startsWith('The ') || error.message.startsWith('Cannot ')
    || error.message.startsWith('Local ') || error.message.startsWith('Existing ') ? error.message : 'Cannot initialize the local AI gateway.');
  process.exitCode = 1;
}
