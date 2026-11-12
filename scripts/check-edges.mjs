import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callModel } from './measure.mjs';
import { backendIndex } from './routing.mjs';

const state = JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
const key = process.env.LAB_APIM_KEY;
if (!key) throw new Error('Provide the in-memory APIM runtime credential.');
const url = `${state.apim.endpoint}/sticky/openai/v1/chat/completions`;
const model = state.deployment;
const body = {
  model, messages: [{ role: 'user', content: 'Reply only ACK.' }],
  max_completion_tokens: 512, reasoning_effort: 'minimal', stream: false,
};
const records = [];
async function check(name, options, expectedStatus = 200) {
  const result = await callModel({ url, key, keyHeader: 'Ocp-Apim-Subscription-Key', body, ...options });
  const passed = result.status === expectedStatus && (expectedStatus !== 200 || result.complete);
  records.push({ name, expectedStatus, passed, ...result });
  await writeFile(resolve('.lab', 'edge-checks.json'), JSON.stringify(records, null, 2));
  if (!passed) throw new Error(`${name}: unexpected response ${result.status}.`);
  return result;
}
for (let index = 0; index < 24; index++) await check('no-session-header', {});
await check('conflicting-identifiers', { session: 'ses_consistent', extraHeaders: { 'x-session-id': 'ses_conflicting' } }, 400);
await check('oversized-identifier', { session: 'x'.repeat(257) }, 400);
await check('identifier-with-space', { session: 'bad identifier' }, 400);
for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
  const session = 'ses_single_header';
  const result = await check(`single-header:${name}`, { extraHeaders: { [name]: session } });
  if (result.backend !== `b${backendIndex(session, model) + 1}`) throw new Error('Single-header affinity differs from the routing oracle.');
}
const first = await check('reconnection-first-request', { session: 'ses_reconnected' });
const second = await check('reconnection-new-http-request', { session: 'ses_reconnected' });
if (first.backend !== second.backend) throw new Error('Reconnected session moved backends.');
console.log(JSON.stringify({
  passed: records.length,
  noHeaderDistribution: Object.fromEntries(['b1', 'b2', 'b3'].map(backend => [
    backend, records.filter(record => record.name === 'no-session-header' && record.backend === backend).length,
  ])),
}, null, 2));
