/**
 * Talk to the configured IFM model straight from the terminal:
 *   npm run k2 -- "your prompt here"
 *   echo "your prompt" | npm run k2
 *   npm run k2 -- --system "You are a triage analyst." "two people trapped"
 *
 * This is a plain chat call, separate from the app's structured adapters.
 */
import { loadEnvFile, readIfmConfig } from '../config.js';
import { IfmClient, IfmError } from '../adapters/ifm.js';

loadEnvFile();
const config = readIfmConfig();

if (!config) {
  console.error('No IFM key found. Put IFM_API_KEY=... in .env, then retry.');
  process.exit(1);
}

const argv = process.argv.slice(2);
let system: string | undefined;
const parts: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--system' || arg === '-s') {
    system = argv[index + 1];
    index += 1;
    continue;
  }
  if (arg !== undefined) parts.push(arg);
}

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const prompt = parts.join(' ').trim() || (await readStdin()).trim();

if (!prompt) {
  console.error('Usage: npm run k2 -- "your prompt"   (or pipe text on stdin)');
  console.error('       npm run k2 -- --system "You are terse." "explain flash floods"');
  process.exit(1);
}

const client = new IfmClient(config);
const startedAt = Date.now();

try {
  const reply = await client.complete(
    system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      : [{ role: 'user', content: prompt }]
  );
  process.stdout.write(`${reply.content.trim()}\n`);
  console.error(
    `\n[${config.model} · ${Date.now() - startedAt}ms · finish=${reply.finishReason ?? 'n/a'}]`
  );
  if (reply.finishReason === 'length') {
    console.error('[reply hit the token cap — raise IFM_MAX_TOKENS in .env for longer answers]');
  }
} catch (error: unknown) {
  const detail =
    error instanceof IfmError
      ? `${error.message}${error.detail ? `\n  ${error.detail}` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`K2 call failed: ${detail}`);
  process.exit(1);
}
