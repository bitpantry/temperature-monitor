// Run with: node --env-file=/path/to/private.env tools/check-status.mjs
const endpoint = new URL(process.env.MONITOR_URL || 'https://example.invalid');
const key = process.env.MONITOR_STATUS_KEY;
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    endpoint.hostname === 'example.invalid' || !/^[a-f0-9]{64}$/.test(key ?? '')) {
  console.error('Set MONITOR_URL and a 64-character MONITOR_STATUS_KEY in a private environment file.');
  process.exit(3);
}
try {
  const res = await fetch(new URL('/api/status', endpoint), {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw Error('Status HTTP ' + res.status);
  const s = await res.json();
  if (typeof s.monitoring !== 'boolean') throw Error('Unexpected status response');
  const code = s.monitoring ? (s.alert?.code ?? 'normal') : 'off';
  const levels = { off: 0, normal: 0, waiting: 0, warm: 1, critical: 2, stale: 2 };
  if (!Object.hasOwn(levels, code)) throw Error('Unexpected alert status');
  const labels = { off: 'Monitoring is off', normal: 'Normal', waiting: 'Waiting for a reading',
    warm: 'Warm (38°F or above)', critical: 'Critical (40°F or above)', stale: 'No fresh reading' };
  console.log(labels[code]);
  process.exitCode = levels[code];
} catch {
  console.error('Could not check the monitor. Check its connection and status key.');
  process.exitCode = 3;
}
