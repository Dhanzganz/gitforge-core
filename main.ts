// How the entry process lives and dies, following the contract that env/src/wire.ts settles:
// take a port the kernel picks, tell the env which port that was, then poll until the env ends
// the trial and exit 0. The graded surface is the server that app.ts builds; this file only
// runs the harness lifecycle around it.
//
//   1. MAKEFUN_ENV_URL carries the env's origin (http://store:8080 inside a trial container).
//      Without it there is nobody to register with, so the program exits 1 at once.
//   2. Build the server and listen(0): the kernel assigns a free port. Never bind 8080 —
//      that port belongs to the env.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request
//      came from together with N as the base URL it dials from then on. Only the first
//      register counts; a 409 means another entry registered first, and this process
//      simply keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The env answers at
//      once ({"done": false} while the suite runs), so this is a poll: retry a failed or
//      slow poll after a short exponential backoff, and never exit before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export
//      the scorer reads.
//
// main.ts pulls in its own server and nothing more: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Upper bound for one register or done request before it is dropped and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The shortest wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff after `attempt` failed requests: doubles from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port again and again until the env takes it. A 200 is the normal answer;
 * a 409 means the first register already won, which is not this process's problem to fix.
 * A 400 or a 405 is a contract error and ends the program; a network failure or any other
 * status is retried, because the env may still be starting up.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405)
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that moment. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or the poll timed out: either way it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
