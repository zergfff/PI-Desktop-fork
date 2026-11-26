/**
 * Boot timing marks.
 *
 * Startup latency is a product feature, and the only way to keep it honest is
 * to measure the phases on a real launch instead of guessing. Enable with
 * `PI_BOOT_TRACE=1`; marks go to stderr so they never enter the app log or the
 * renderer, and cost nothing when the variable is unset.
 */
const enabled = process.env.PI_BOOT_TRACE === "1";
const origin = Date.now();

export function bootMark(label: string): void {
  if (!enabled) return;
  process.stderr.write(`[boot] ${Date.now() - origin}ms ${label}\n`);
}
