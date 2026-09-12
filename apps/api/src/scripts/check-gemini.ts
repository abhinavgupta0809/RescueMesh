/**
 * One-command check that a pasted Gemini key works end to end:
 *   npm run gemini:check
 *
 * Makes THREE real requests (one per check) and prints what came back. This is
 * the only thing in the repo that spends Gemini quota, and it is never invoked
 * by the app, the tests, or the demo.
 */
import { pittsburghFloodScenario } from '@rescuemesh/shared';
import { loadEnvFile, readGeminiConfig } from '../config.js';
import { GeminiClient, GeminiError, GeminiReasoningAdapter } from '../adapters/gemini.js';

const envFile = loadEnvFile();
const config = readGeminiConfig();

if (!config) {
  console.error('No Gemini key found.\n');
  console.error('  1. Get a key from Google AI Studio: https://aistudio.google.com/apikey');
  console.error('  2. cp .env.example .env   (if you have not already)');
  console.error('  3. put the key in that file:  GEMINI_API_KEY=AIza...');
  console.error('  4. npm run gemini:check\n');
  console.error(envFile.path ? `Checked env file: ${envFile.path}` : 'No .env file found yet.');
  console.error('\nThe demo still runs without a key: the chiefs answer from deterministic');
  console.error('mocks, labelled "mock" on every card.');
  process.exit(1);
}

const masked = `${config.apiKey.slice(0, 6)}…${config.apiKey.slice(-4)}`;
console.log('Gemini configuration');
console.log(`  env file   ${envFile.path ?? '(none — using process env)'}`);
console.log(`  base url   ${config.baseUrl}`);
console.log(`  model      ${config.model}`);
console.log(`  key        ${masked}`);
console.log(`  timeout    ${config.timeoutMs}ms\n`);

const client = new GeminiClient(config);
const reasoning = new GeminiReasoningAdapter(client);
const failures: string[] = [];

const step = async (label: string, run: () => Promise<string>) => {
  const startedAt = Date.now();
  try {
    const detail = await run();
    console.log(`PASS  ${label}  (${Date.now() - startedAt}ms)`);
    console.log(`      ${detail}\n`);
  } catch (error: unknown) {
    const reason =
      error instanceof GeminiError
        ? `${error.message}${error.detail ? `\n      detail: ${error.detail}` : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`FAIL  ${label}  (${Date.now() - startedAt}ms)`);
    console.error(`      ${reason}\n`);
    failures.push(label);
  }
};

await step('endpoint reachable and key accepted', async () => {
  const reply = await client.generateJson(
    'Reply with a JSON object and nothing else.',
    'Return exactly {"ready": true}'
  );
  return `reply: ${reply.trim().slice(0, 80)}`;
});

await step('field report parsed into a validated incident', async () => {
  const incident = await reasoning.parseReport(
    'Squirrel Hill tunnel outbound, water over the roadway, two people trapped on a car roof.'
  );
  return `severity=${incident.severity}  title="${incident.title}"`;
});

await step('chief recommendation validated, including its proposed action', async () => {
  const recommendation = await reasoning.recommend('incident_commander', pittsburghFloodScenario);
  const action = recommendation.proposedAction
    ? `proposedAction=${recommendation.proposedAction.kind}` +
      (recommendation.proposedAction.incidentIds
        ? ` incidents=[${recommendation.proposedAction.incidentIds.join(', ')}]`
        : ' (no incident filter)')
    : 'proposedAction=none (advisory only)';
  return `confidence=${recommendation.confidence}  ${action}\n      summary="${recommendation.summary}"`;
});

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  console.error(
    'The app still runs — the chiefs fall back to deterministic mocks, labelled as such.'
  );
  process.exit(1);
}

console.log('All checks passed. The five chiefs will run live on Gemini.');
