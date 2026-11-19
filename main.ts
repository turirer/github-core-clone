// Entry point: connect this forge to the trial environment and stay up
// until the trial ends.
//
// The environment drives the trial; this process only has to do three
// things, in order:
//
//   1. Start the forge server on a port the kernel picks (listen on 0).
//      Port 8080 belongs to the environment, so it is never bound here.
//   2. Tell the environment which port was picked, by POSTing it to
//      $MAKEFUN_ENV_URL/register. The environment records where the
//      request came from plus that port and dials the forge from then on.
//      The first registration wins: a 409 means another entry already
//      registered, and this process simply carries on waiting.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then close the server and exit 0. The environment answers each
//      poll at once ({"done": false} while the suite is still running),
//      so polling is a loop with a short backoff, never a held request.
//
// The forge itself is app.ts and the modules behind it; this file only
// owns the lifecycle above, so it imports the server and nothing else.

import { createApp } from "./app.ts";

// Origin of the trial environment, from the environment. Without it
// there is nothing to register with, so the process stops right away.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is not set, so there is no environment to join\n");
  process.exit(1);
}

// One request may take at most this long before it is abandoned and
// retried; the environment may still be starting up.
const REQUEST_LIMIT_MS = 30_000;
// Retries wait this long first, then double each time up to the cap.
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait before the next retry after `failures` failed attempts:
// exponential from FIRST_WAIT_MS, capped at LONGEST_WAIT_MS.
function waitBeforeRetry(failures: number): number {
  const doubled = FIRST_WAIT_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_WAIT_MS, doubled);
}

class FatalReply extends Error {}

// Run `work` until it reports success, retrying on failure with the
// backoff above. `work` returns true when its goal is reached, false
// when the attempt failed in a retryable way, and throws FatalReply
// for a failure that must end the program instead of being retried.
async function keepTrying(work: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      if (await work()) return;
    } catch (err) {
      if (err instanceof FatalReply) throw err;
      // Anything else is a transient failure: fall through and retry.
    }
    await pause(waitBeforeRetry(failures));
  }
}

// Register the bound port with the environment. A 200 means the
// environment accepted it; a 409 means another entry registered first,
// which is not this process's problem. A 400 or 405 means the request
// itself is wrong, so it is fatal; any other status, or a network
// failure, is retried because the environment may still be starting.
async function announcePort(port: number): Promise<void> {
  await keepTrying(async () => {
    const res = await fetch(`${envOrigin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new FatalReply(`register was refused with HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  });
}

// Ask the environment whether the trial is over, until it says yes.
// A poll that errors or answers anything other than {"done": true}
// just means "not yet", so it is retried.
async function waitUntilDone(): Promise<void> {
  await keepTrying(async () => {
    const res = await fetch(`${envOrigin}/done`, {
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

// The whole life of the process: bind, announce, wait, shut down.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind a TCP port");
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("[entry] port announced; waiting for the trial to finish\n");

  await waitUntilDone();
  server.close();
  process.stdout.write("[entry] trial finished, shutting down\n");
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
