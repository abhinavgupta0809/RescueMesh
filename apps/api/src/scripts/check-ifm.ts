/**
 * One-command check that the pasted IFM key works end to end:
 *   npm run ifm:check
 * Makes two real calls (a plain chat completion and one report parse) and
 * prints what came back. Exits non-zero on any failure.
 */
import { pittsburghFloodScenario } from '@rescuemesh/shared';
import { loadEnvFile, readIfmConfig } from '../config.js';
import { IfmClient, IfmError, IfmReasoningAdapter } from '../adapters/ifm.js';

const envFile = loadEnvFile();
const config = readIfmConfig();

if (!config) {
  console.error('No IFM key found.\n');
  console.error('  1. cp .env.example .env');
  console.error('  2. put your key in that file:  IFM_API_KEY=IFM-xf...');
  console.error('  3. npm run ifm:check\n');
  console.error(envFile.path ? `Checked env file: ${envFile.path}` : 'No .env file found yet.');
  process.exit(1);
}

const maskedKey = `${config.apiKey.slice(0, 6)}…${config.apiKey.slice(-4)}`;
console.log('IFM configuration');
console.log(`  env file   ${envFile.path ?? '(none — using process env)'}`);
console.log(`  base url   ${config.baseUrl}`);
console.log(`  model      ${config.model}`);
console.log(`  key        ${maskedKey}`);
console.log(`  timeout    ${config.timeoutMs}ms\n`);

const client = new IfmClient(config);
const failures: string[] = [];

const step = async (label: string, run: () => Promise<string>) => {
  const startedAt = Date.now();
  try {
    const detail = await run();
    console.log(`PASS  ${label}  (${Date.now() - startedAt}ms)`);
    console.log(`      ${detail}\n`);
  } catch (error: unknown) {
    const reason =
      error instanceof IfmError
        ? `${error.message}${error.detail ? `\n      detail: ${error.detail}` : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`FAIL  ${label}  (${Date.now() - startedAt}ms)`);
    console.error(`      ${reason}\n`);
    failures.push(label);
  }
};

await step('chat completion reachable', async () => {
  const reply = await client.complete(
    [{ role: 'user', content: 'Reply with the single word: ready' }],
    600
  );
  const tail = reply.content.trim().split(/\s+/).slice(-6).join(' ');
  return `finish=${reply.finishReason ?? 'n/a'}  reply tail: ${tail.slice(-80)}`;
});

const reasoning = new IfmReasoningAdapter(client);

await step('field report parsed into a structured incident', async () => {
  const incident = await reasoning.parseReport(
    'Squirrel Hill tunnel outbound, water over the roadway, two people trapped on a car roof.'
  );
  return `severity=${incident.severity}  title="${incident.title}"`;
});

await step('incident commander recommendation validated', async () => {
  const recommendation = await reasoning.recommend('incident_commander', pittsburghFloodScenario);
  return `confidence=${recommendation.confidence}  summary="${recommendation.summary}"`;
});

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  console.error('The app still runs — it falls back to deterministic mock reasoning.');
  process.exit(1);
}

console.log('All checks passed. Run `npm run dev` and open http://localhost:5173');
