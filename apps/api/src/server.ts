import { app } from './app.js';
import { envFile, ifmConfig } from './adapters/index.js';

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`RescueMesh API listening on http://localhost:${port}`);
  if (envFile.path) console.log(`  env file       ${envFile.path}`);
  if (ifmConfig) {
    console.log(`  reasoning      IFM ${ifmConfig.model}`);
    console.log(`  base url       ${ifmConfig.baseUrl}`);
    console.log('  fallback       deterministic mock on any IFM error');
  } else {
    console.log('  reasoning      deterministic mock (no IFM_API_KEY set)');
    console.log('  to use K2      put IFM_API_KEY=... in .env, then restart');
  }
});
