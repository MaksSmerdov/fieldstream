const port = process.env.COLLECTOR_HTTP_PORT ?? '8091';

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(2000),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
