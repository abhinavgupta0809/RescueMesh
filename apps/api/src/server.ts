import { app } from './app.js';
import { envFile, geminiConfig } from './adapters/index.js';

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`RescueMesh API listening on http://localhost:${port}`);
  if (envFile.path) console.log(`  env file       ${envFile.path}`);
  console.log('  world          deterministic simulation engine (authoritative)');
  if (geminiConfig) {
    console.log(`  chiefs         Gemini ${geminiConfig.model}`);
    console.log('  fallback       deterministic mock on any Gemini error');
  } else {
    console.log('  chiefs         deterministic mock (no GEMINI_API_KEY set)');
    console.log('  to use Gemini  put GEMINI_API_KEY=... in .env, then restart');
  }
});
