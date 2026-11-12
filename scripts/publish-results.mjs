import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const output = resolve('results');
await mkdir(output, { recursive: true });
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n');
const pick = (record, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
const numericFields = [
  'turn', 'status', 'complete', 'promptTokens', 'cachedTokens', 'outputTokens', 'ttftMs', 'totalMs',
];
function metrics(record) {
  return {
    ...pick(record, numericFields),
    backend: ['b1', 'b2', 'b3'].includes(record.backend) ? record.backend : 'unknown',
    attempts: Number(record.attempts) >= 1 ? Number(record.attempts) : null,
    resourceLogVerified: record.backendEvidence === 'Azure OpenAI resource diagnostic log',
  };
}
const summaryFields = [
  'run', 'gateway', 'scenario', 'workers', 'turns', 'rpm', 'sessionHeadersSent',
  'requests', 'completed', 'failed', 'sessions', 'usageCoverage', 'backendCoverage', 'resourceLogCoverage',
  'sessionsWithKnownBackend', 'sessionsSwitchingBackend', 'sessionDistribution', 'requestDistribution',
  'initialSessionDistribution', 'expectedFirstAttemptRatio', 'attemptCoverage', 'retriedRequests',
  'cacheRatio', 'warmCacheRatio', 'inputTokens', 'cachedTokens', 'outputTokens', 'byTurn',
  'ttftP50Ms', 'ttftP95Ms', 'totalP50Ms', 'totalP95Ms',
];
const summaries = await read(resolve('.lab', 'summaries.json'));
const requests = [];
const comparisons = [];
const pilots = [];
for (const summary of summaries) {
  if (!/^(apim|aigateway)-(single|balanced|sticky)-[a-f0-9]{8}$/.test(summary.run)) throw new Error('Unexpected public run identifier.');
  const records = (await readFile(resolve('.lab', 'enriched', summary.run, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const sessions = new Map();
  for (const record of records) {
    if (!sessions.has(record.session)) sessions.set(record.session, sessions.size + 1);
    requests.push({
      run: summary.run, sessionOrdinal: sessions.get(record.session), ...metrics(record),
      expectedBackend: ['b1', 'b2', 'b3'].includes(record.expectedBackend) ? record.expectedBackend : null,
      recoveryBuffered: Boolean(record.recoveryBuffered),
    });
  }
  const eligible = records.filter(record => record.complete && record.expectedBackend && Number(record.attempts) === 1);
  const sanitized = {
    ...pick(summary, summaryFields),
    unexplainedFirstAttemptMismatches: eligible.length ? eligible.filter(record => record.backend !== record.expectedBackend).length : null,
  };
  (summary.requests === 360 && summary.sessions === 60 ? comparisons : pilots).push(sanitized);
}
await save('comparisons.json', comparisons);
await save('pilots.json', pilots);
await writeFile(resolve(output, 'requests.jsonl'), requests.map(record => JSON.stringify(record)).join('\n') + '\n');

const faults = [];
for (const entry of await readdir(resolve('.lab', 'faults'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = resolve('.lab', 'faults', entry.name);
  if (!(await readdir(path)).includes('summary.json')) continue;
  const summary = await read(resolve(path, 'summary.json'));
  const restoration = await read(resolve(path, 'restoration.json'));
  const rows = await read(resolve(path, 'requests.json'));
  const sessions = new Map();
  const tests = Object.fromEntries(Object.entries(summary.tests).map(([name, result]) => [name, {
    ...pick(result, ['requests', 'completed', 'failed']),
    retried: summary.gateway === 'aigateway' ? null : result.retried,
    bufferedRecovery: summary.gateway === 'aigateway' ? null : result.bufferedRecovery,
  }]));
  faults.push({
    run: summary.run, gateway: summary.gateway, cold: Boolean(summary.cold), restored: summary.restored,
    restoredUtc: restoration.utc, tests,
    requests: rows.map(record => {
      if (!sessions.has(record.session)) sessions.set(record.session, sessions.size + 1);
      return { test: record.test, phase: record.phase, sessionOrdinal: sessions.get(record.session), ...metrics(record) };
    }),
  });
}
for (const fault of faults) {
  const latest = faults.filter(other => other.gateway === fault.gateway && !other.cold)
    .sort((a, b) => Date.parse(b.restoredUtc) - Date.parse(a.restoredUtc))[0];
  fault.evidenceRole = fault.cold ? 'Isolated transport check' :
    (fault === latest ? 'Latest sequential fault checks' : 'Earlier exploratory sequence');
}
await save('faults.json', faults);
const edges = await read(resolve('.lab', 'edge-checks.json'));
await save('edge-checks.json', edges.map(record => ({
  ...pick(record, ['name', 'expectedStatus', 'passed']), ...metrics(record),
})));
await save('cache-scope.json', (await read(resolve('.lab', 'enriched', 'cache-scope.json'))).map(record => ({
  trial: record.trial, intendedBackend: record.intendedBackend, ...metrics(record),
})));

const clients = [];
for (const gateway of ['mock', 'apim', 'aigateway', 'apim-direct', 'aigateway-direct']) {
  const parent = resolve('.lab', 'opencode', gateway);
  const children = await readdir(parent, { withFileTypes: true });
  const candidateRuns = children.filter(entry => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name)).map(entry => entry.name).sort();
  if (!candidateRuns.length) throw new Error(`No completed validated OpenCode run for ${gateway}.`);
  const path = resolve(parent, candidateRuns.at(-1));
  const conversations = await read(resolve(path, 'client-results.json'));
  const captured = await read(resolve(path, 'request-metadata.json'));
  const first = captured[0];
  const ids = captured.map(record => record.sessionHeaders['x-opencode-session']);
  clients.push({
    gateway, version: conversations[0].version, completedConversations: conversations.filter(record => record.completed).length,
    continuationPreservedSession: conversations[0].session === conversations[1].session,
    newConversationChangedSession: conversations[0].session !== conversations[2].session,
    capturedRequests: captured.length,
    ...(first ? {
      sessionHeaders: Object.keys(first.sessionHeaders),
      allSessionHeadersAgree: captured.every(record => new Set(Object.values(record.sessionHeaders)).size === 1),
      observedContinuationPreservedSession: ids[0] === ids[1],
      observedNewConversationChangedSession: ids[0] !== ids[2],
      projectStable: captured.every(record => record.projectHash === first.projectHash),
      traceChanged: new Set(captured.map(record => record.traceparentHash)).size === captured.length,
      cookiesReturned: captured.some(record => record.cookieSent),
      streaming: captured.every(record => record.stream),
    } : {}),
  });
}
await save('opencode.json', clients);
const state = await read(resolve('.lab', 'state.json'));
const inventory = await read(resolve('.lab', 'inventory-before-cleanup.json'));
await save('lifecycle.json', {
  startedUtc: state.startedUtc, cleanedUtc: state.cleanedUtc ?? null,
  cleanupVerified: state.cleanupVerified === true,
  inventoriedResources: inventory.map(resource => ({
    type: resource.type, purposeTagVerified: resource.tags.purpose === 'llm-cache-affinity-lab',
    ownerTagVerified: resource.tags.owner === state.owner,
    expectedScopeVerified: state.expectedRoots.some(root => resource.id.toLowerCase() === root.toLowerCase() ||
      resource.id.toLowerCase().startsWith(`${root.toLowerCase()}/`)),
  })),
  comparisonInputTokens: comparisons.reduce((sum, record) => sum + record.inputTokens, 0),
  comparisonCachedTokens: comparisons.reduce((sum, record) => sum + record.cachedTokens, 0),
  comparisonOutputTokens: comparisons.reduce((sum, record) => sum + record.outputTokens, 0),
});
console.log(`Published ${comparisons.length} full comparisons, ${requests.length} sanitized measured requests, ${faults.length} fault runs, and ${clients.length} client checks.`);
