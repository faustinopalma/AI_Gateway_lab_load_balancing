import { createHash } from 'node:crypto';

export const SESSION_HEADERS = [
  'x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id',
];

export function sessionHeader(headers) {
  const present = SESSION_HEADERS.filter(name => headers.has(name));
  if (!present.length) return null;
  const values = present.map(name => headers.get(name));
  if (values.some(value => !value || value.length > 256 || !/^[\x21-\x7e]+$/.test(value))) {
    throw new Error('Invalid session identifier.');
  }
  if (new Set(values).size !== 1) throw new Error('Conflicting session identifiers.');
  return { name: present[0], value: values[0] };
}

export function backendIndex(session, model, partition = 'lab', count = 3) {
  const digest = createHash('sha256').update(`${partition}|${model}|${session}`).digest();
  return digest.readUInt32BE(0) % count;
}

export function summarize(records) {
  const complete = records.filter(record => record.complete);
  const usage = complete.filter(record => Number.isFinite(record.promptTokens) && Number.isFinite(record.cachedTokens));
  const sessions = new Map();
  for (const record of complete) {
    if (!record.session) continue;
    const key = `${record.model}|${record.session}`;
    if (!sessions.has(key)) sessions.set(key, new Set());
    if (record.backend && record.backend !== 'unknown') sessions.get(key).add(record.backend);
  }
  const distribution = {};
  for (const backends of sessions.values()) {
    for (const backend of backends) distribution[backend] = (distribution[backend] ?? 0) + 1;
  }
  const ratio = rows => {
    const total = rows.reduce((sum, record) => sum + record.promptTokens, 0);
    return total ? rows.reduce((sum, record) => sum + record.cachedTokens, 0) / total : null;
  };
  const quantile = (name, percentile) => {
    const values = complete.map(record => record[name]).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? values[Math.ceil(percentile * values.length) - 1] : null;
  };
  const knownSessions = [...sessions.values()].filter(backends => backends.size);
  return {
    requests: records.length,
    completed: complete.length,
    failed: records.length - complete.length,
    usageCoverage: complete.length ? usage.length / complete.length : null,
    backendCoverage: complete.length ? complete.filter(record => record.backend && record.backend !== 'unknown').length / complete.length : null,
    sessions: sessions.size,
    sessionsWithKnownBackend: knownSessions.length,
    sessionsSwitchingBackend: knownSessions.filter(backends => backends.size > 1).length,
    sessionDistribution: distribution,
    requestDistribution: Object.fromEntries([...new Set(complete.map(record => record.backend ?? 'unknown'))]
      .map(backend => [backend, complete.filter(record => (record.backend ?? 'unknown') === backend).length])),
    initialSessionDistribution: Object.fromEntries([...new Set(complete.filter(record => record.turn === 0).map(record => record.backend ?? 'unknown'))]
      .map(backend => [backend, complete.filter(record => record.turn === 0 && (record.backend ?? 'unknown') === backend).length])),
    expectedFirstAttemptRatio: complete.some(record => record.expectedBackend)
      ? complete.filter(record => record.expectedBackend && record.backend === record.expectedBackend && Number(record.attempts) === 1).length /
        complete.filter(record => record.expectedBackend).length : null,
    attemptCoverage: complete.length ? complete.filter(record => Number(record.attempts) >= 1).length / complete.length : null,
    retriedRequests: complete.some(record => Number(record.attempts) >= 1)
      ? complete.filter(record => Number(record.attempts) > 1).length : null,
    cacheRatio: ratio(usage),
    warmCacheRatio: ratio(usage.filter(record => record.turn > 0)),
    inputTokens: usage.reduce((sum, record) => sum + record.promptTokens, 0),
    cachedTokens: usage.reduce((sum, record) => sum + record.cachedTokens, 0),
    outputTokens: complete.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
    byTurn: Object.fromEntries([...new Set(records.map(record => record.turn).filter(Number.isInteger))].sort((a, b) => a - b)
      .map(turn => [turn + 1, { requests: records.filter(record => record.turn === turn).length,
        cacheRatio: ratio(usage.filter(record => record.turn === turn)) }])),
    ttftP50Ms: quantile('ttftMs', 0.5),
    ttftP95Ms: quantile('ttftMs', 0.95),
    totalP50Ms: quantile('totalMs', 0.5),
    totalP95Ms: quantile('totalMs', 0.95),
  };
}
