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
console.log(JSON.stringify(summaries.map(summary => ({
  gateway: summary.gateway, scenario: summary.scenario, run: summary.run,
  completed: summary.completed, backendCoverage: summary.backendCoverage,
  logCoverage: summary.resourceLogCoverage, switches: summary.sessionsSwitchingBackend,
  requests: summary.requestDistribution, cacheWarm: summary.warmCacheRatio,
})), null, 2));
