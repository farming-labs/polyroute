/** Times the first verified response; process cleanup is outside the sample. */
export async function measureColdStart({ start, request, stop, now = () => performance.now() }) {
  const started = now();
  const server = start();
  try {
    const ok = await request(await server.origin);
    return { ok, ms: now() - started };
  } finally {
    await stop(server.child);
  }
}
