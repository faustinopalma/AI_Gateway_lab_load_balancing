import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callModel } from './measure.mjs';
import { backendIndex } from './routing.mjs';

const state = JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
const gateway = process.argv[2] ?? 'apim';
if (!['apim', 'aigateway'].includes(gateway)) throw new Error('Choose apim or aigateway.');
const key = gateway === 'apim' ? process.env.LAB_APIM_KEY : process.env.LAB_AIGATEWAY_KEY;
if (!key) throw new Error('Provide the in-memory gateway runtime credential.');
const url = gateway === 'apim' ? `${state.apim.endpoint}/sticky/openai/v1/chat/completions` : state.aiGateway.chatUrl;
const model = gateway === 'apim' ? state.deployment : `${state.model}-sticky`;
const keyHeader = gateway === 'apim' ? 'Ocp-Apim-Subscription-Key' : 'Authorization';
const file = gateway === 'apim' ? 'edge-checks.json' : 'native-edge-checks.json';
const body = {
  model, messages: [{ role: 'user', content: 'Reply only ACK.' }],
  max_completion_tokens: 512, reasoning_effort: 'minimal', stream: false,
};
const records = [];
async function check(name, options, expectedStatus = 200) {
  const result = await callModel({ url, key, keyHeader, body, ...options });
  const passed = result.status === expectedStatus && (expectedStatus !== 200 || result.complete);
  records.push({ gateway, name, model, session: options.session ?? options.extraHeaders?.['x-opencode-session'] ?? null,
    expectedStatus, passed, ...result });
  await writeFile(resolve('.lab', file), JSON.stringify(records, null, 2));
  if (!passed) throw new Error(`${name}: unexpected response ${result.status}.`);
  return result;
}
for (let index = 0; index < 24; index++) await check('no-session-header', {});
if (gateway === 'apim') {
  await check('conflicting-identifiers', { session: 'ses_consistent', extraHeaders: { 'x-session-id': 'ses_conflicting' } }, 400);
  await check('oversized-identifier', { session: 'x'.repeat(257) }, 400);
  await check('identifier-with-space', { session: 'bad identifier' }, 400);
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    const session = 'ses_single_header';
    const result = await check(`single-header:${name}`, { extraHeaders: { [name]: session } });
    if (result.backend !== `b${backendIndex(session, model) + 1}`) throw new Error('Single-header affinity differs from the routing oracle.');
  }
} else {
  for (let index = 0; index < 3; index++) {
    await check('single-opencode-header', { extraHeaders: { 'x-opencode-session': 'ses_single_header' } });
  }
  await check('empty-session-header', { extraHeaders: { 'x-opencode-session': '' } });
  await check('streaming', { session: 'ses_reconnected', body: { ...body, stream: true, stream_options: { include_usage: true } } });
}
const first = await check('reconnection-first-request', { session: 'ses_reconnected' });
const second = await check('reconnection-new-http-request', { session: 'ses_reconnected' });
if (gateway === 'apim' && first.backend !== second.backend) throw new Error('Reconnected session moved backends.');
console.log(JSON.stringify({
  passed: records.length,
  noHeaderDistribution: gateway === 'apim' ? Object.fromEntries(['b1', 'b2', 'b3'].map(backend => [
    backend, records.filter(record => record.name === 'no-session-header' && record.backend === backend).length,
  ])) : null,
  backendVerification: gateway === 'apim' ? 'APIM selection headers' : 'Requires model diagnostic-log correlation',
}, null, 2));
