import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarize } from './routing.mjs';

const table = JSON.parse(await readFile(resolve('.lab', 'backend-correlations.json'), 'utf8')).tables[0];
const idColumn = table.columns.findIndex(column => column.name === 'CorrelationId');
const resourceColumn = table.columns.findIndex(column => column.name === 'Resource');
if (idColumn < 0 || resourceColumn < 0) throw new Error('Backend-log correlation columns are missing.');
const identities = new Map();
for (const row of table.rows) {
  const backend = row[resourceColumn].match(/-b([123])$/i)?.[1];
  if (!backend) throw new Error('Unexpected backend in the lab workspace.');
  const id = row[idColumn].toLowerCase();
  const label = `b${backend}`;
  if (identities.has(id) && identities.get(id) !== label) throw new Error('Ambiguous serving-backend evidence.');
  identities.set(id, label);
}
const summaries = [];
function enrichRecord(record) {
  const id = record.backendRequestId ?? record.requestId;
  const actual = id ? identities.get(id.toLowerCase()) : null;
  if (actual && record.backend && record.backend !== 'unknown' && record.backend !== actual) {
    throw new Error('Routing telemetry disagrees with resource diagnostics.');
  }
  return {
    ...record, backend: actual ?? record.backend,
    backendEvidence: actual ? 'Azure OpenAI resource diagnostic log' :
      (record.backend && record.backend !== 'unknown' ? 'APIM selected direct backend and completed response' : 'unavailable'),
  };
}
for (const entry of await readdir(resolve('.lab', 'runs'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = resolve('.lab', 'runs', entry.name);
  const files = await readdir(path);
  if (!files.includes('summary.json')) continue;
  const original = JSON.parse(await readFile(resolve(path, 'summary.json'), 'utf8'));
  const records = (await readFile(resolve(path, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .map(line => enrichRecord(JSON.parse(line)));
  const folder = resolve('.lab', 'enriched', entry.name);
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'requests.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const summary = { ...original, ...summarize(records),
    resourceLogCoverage: records.filter(record => record.backendEvidence === 'Azure OpenAI resource diagnostic log').length / records.length };
  await writeFile(resolve(folder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  summaries.push(summary);
}
await writeFile(resolve('.lab', 'summaries.json'), JSON.stringify(summaries, null, 2) + '\n');
if ((await readdir(resolve('.lab'))).includes('cache-scope.json')) {
  const records = JSON.parse(await readFile(resolve('.lab', 'cache-scope.json'), 'utf8')).map(enrichRecord);
  await writeFile(resolve('.lab', 'enriched', 'cache-scope.json'), JSON.stringify(records, null, 2) + '\n');
}
if ((await readdir(resolve('.lab'))).includes('edge-checks.json')) {
  const records = JSON.parse(await readFile(resolve('.lab', 'edge-checks.json'), 'utf8')).map(enrichRecord);
  if (records.some(record => record.complete && record.backendEvidence !== 'Azure OpenAI resource diagnostic log')) {
    throw new Error('APIM edge checks require complete serving-backend log correlation for completed model responses.');
  }
  await writeFile(resolve('.lab', 'enriched', 'edge-checks.json'), JSON.stringify(records, null, 2) + '\n');
}
if ((await readdir(resolve('.lab'))).includes('native-edge-checks.json')) {
  const records = JSON.parse(await readFile(resolve('.lab', 'native-edge-checks.json'), 'utf8')).map(enrichRecord);
  await writeFile(resolve('.lab', 'enriched', 'native-edge-checks.json'), JSON.stringify(records, null, 2) + '\n');
  if (records.some(record => record.backendEvidence !== 'Azure OpenAI resource diagnostic log')) {
    throw new Error('Native edge checks require complete serving-backend log correlation.');
  }
  for (const session of new Set(records.map(record => record.session).filter(Boolean))) {
    if (new Set(records.filter(record => record.session === session).map(record => record.backend)).size !== 1) {
      throw new Error('Native edge-case session changed serving backend.');
    }
  }
  if ((await readdir(resolve('.lab'))).includes('faults')) {
    for (const entry of await readdir(resolve('.lab', 'faults'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = resolve('.lab', 'faults', entry.name);
      if (!(await readdir(source)).includes('summary.json')) continue;
      const summary = JSON.parse(await readFile(resolve(source, 'summary.json'), 'utf8'));
      const records = JSON.parse(await readFile(resolve(source, 'requests.json'), 'utf8')).map(enrichRecord);
      for (const [test, result] of Object.entries(summary.tests)) {
        const during = records.filter(record => record.test === test && record.phase === 'during' && record.complete);
        const after = records.filter(record => record.test === test && record.phase === 'after' && record.complete);
        result.resourceLogCoverage = during.length
          ? during.filter(record => record.backendEvidence === 'Azure OpenAI resource diagnostic log').length / during.length : null;
        if (result.faultVerified && result.resourceLogCoverage === 1 && during.some(record => record.backend === 'b1')) {
          throw new Error(`${summary.gateway}/${test}: a completed fault-phase request still reached b1.`);
        }
        result.sessionsMigrated = result.resourceLogCoverage === 1
          ? new Set(during.filter(record => record.backend !== record.expectedBackend).map(record => record.session)).size : null;
        result.sessionsReturnedHome = after.every(record => record.backendEvidence === 'Azure OpenAI resource diagnostic log')
          ? new Set(after.filter(record => record.backend === record.expectedBackend).map(record => record.session)).size : null;
      }
      const folder = resolve('.lab', 'enriched', entry.name);
      await mkdir(folder, { recursive: true });
      await writeFile(resolve(folder, 'requests.json'), JSON.stringify(records, null, 2) + '\n');
      await writeFile(resolve(folder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    }
  }
  if ((await readdir(resolve('.lab'))).includes('opencode')) {
    for (const gateway of ['apim', 'aigateway']) {
      const parent = resolve('.lab', 'opencode', gateway);
      const runs = (await readdir(parent, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name)).map(entry => entry.name).sort();
      if (!runs.length) throw new Error(`Missing observed OpenCode run for ${gateway}.`);
      const captured = JSON.parse(await readFile(resolve(parent, runs.at(-1), 'request-metadata.json'), 'utf8')).map(enrichRecord);
      if (captured.length < 3 || captured.some(record => record.backendEvidence !== 'Azure OpenAI resource diagnostic log')) {
        throw new Error(`OpenCode ${gateway} requires complete serving-backend log correlation.`);
      }
      if (captured[0].backend !== captured[1].backend) throw new Error(`OpenCode ${gateway} continuation changed backend.`);
      await writeFile(resolve('.lab', 'enriched', `opencode-${gateway}.json`), JSON.stringify(captured, null, 2) + '\n');
    }
  }
  if (new Set(records.filter(record => record.name === 'no-session-header').map(record => record.backend)).size !== 3) {
    throw new Error('Native requests without session headers did not reach all three backends.');
  }
}
console.log(JSON.stringify(summaries.map(summary => ({
  gateway: summary.gateway, scenario: summary.scenario, run: summary.run,
  completed: summary.completed, backendCoverage: summary.backendCoverage,
  logCoverage: summary.resourceLogCoverage, switches: summary.sessionsSwitchingBackend,
  requests: summary.requestDistribution, cacheWarm: summary.warmCacheRatio,
})), null, 2));
