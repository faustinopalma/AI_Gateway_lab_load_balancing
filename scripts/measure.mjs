import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { backendIndex, summarize } from './routing.mjs';

export function parseEvent(data) {
  if (data === '[DONE]') return { done: true };
  const event = JSON.parse(data);
  if (event.error) return { error: event.error };
  return {
    usage: event.usage,
    content: event.choices?.some(choice => choice.delta?.content || choice.delta?.tool_calls?.some(call => call.function?.arguments)),
    finished: event.choices?.some(choice => choice.finish_reason != null),
    model: event.model,
  };
}

export async function callModel({ url, key, keyHeader = 'Authorization', body, session, extraHeaders = {}, timeoutMs = 180000 }) {
  const started = performance.now();
  const headers = { 'content-type': 'application/json' };
  const traceId = randomUUID().replaceAll('-', '');
  headers.traceparent = `00-${traceId}-${randomUUID().replaceAll('-', '').slice(0, 16)}-01`;
  const clientRequestId = randomUUID();
  headers['x-ms-client-request-id'] = clientRequestId;
  if (key) headers[keyHeader] = keyHeader === 'Authorization' ? `Bearer ${key}` : key;
  if (session) {
    for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) headers[name] = session;
    headers['x-opencode-project'] = 'synthetic-lab-project';
    headers['x-opencode-client'] = 'cli';
  }
  Object.assign(headers, extraHeaders);
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const result = {
    status: response.status, complete: false,
    startedUtc: new Date(performance.timeOrigin + started).toISOString(),
    backend: response.headers.get('x-lab-backend') ?? 'unknown',
    backendType: response.headers.get('x-lab-backend-type'),
    attempts: response.headers.get('x-lab-attempts'),
    observedSessionHeader: response.headers.get('x-lab-session-header'),
    traceId, clientRequestId, echoedClientRequestId: response.headers.get('x-ms-client-request-id'),
    requestId: response.headers.get('apim-request-id'),
    backendRequestId: response.headers.get('x-lab-backend-request-id'),
    attemptLog: response.headers.get('x-lab-attempt-log'),
    attemptPath: response.headers.get('x-lab-attempt-path'),
    upstreamRequestId: response.headers.get('x-request-id'),
    recoveryBuffered: response.headers.get('x-lab-recovery-buffered') === 'true',
    totalMs: null, ttftMs: null, promptTokens: null, cachedTokens: null, outputTokens: null,
  };
  const assignUsage = usage => {
    if (!usage) return;
    result.promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? null;
    result.cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null;
    result.outputTokens = usage.completion_tokens ?? usage.output_tokens ?? null;
  };
  if (!response.ok) {
    const error = await response.text();
    result.error = error.slice(0, 1000);
  } else if (body.stream) {
    let buffer = '';
    let done = false;
    let finished = false;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = parseEvent(data);
        if (event.error) result.error = JSON.stringify(event.error);
        if (event.content && result.ttftMs === null) result.ttftMs = performance.now() - started;
        if (event.done) done = true;
        if (event.finished) finished = true;
        assignUsage(event.usage);
      }
    }
    result.complete = done && finished && !result.error;
    if (!result.complete && !result.error) result.error = 'Incomplete SSE response: terminal event or finish reason missing.';
  } else {
    const data = await response.json();
    assignUsage(data.usage);
    result.complete = Array.isArray(data.choices) && data.choices.some(choice => choice.finish_reason != null) && !data.error;
    if (!result.complete) result.error = JSON.stringify(data.error ?? 'No completed choice.');
  }
  result.totalMs = performance.now() - started;
  return result;
}

export function fixture(run, session, turn, model, stream = true) {
  const instructions = Array.from({ length: 240 }, (_, index) =>
    `Rule ${index}: validate inputs, preserve existing behavior, test each change, and explain the result clearly.`).join('\n');
  const messages = [
    { role: 'system', content: `Synthetic run ${run}; session ${session}.\nYou are testing an API gateway. Reply only ACK. Never call tools.\n${instructions}` },
  ];
  for (let index = 0; index < turn; index++) {
    messages.push({ role: 'user', content: `Turn ${index + 1}: acknowledge this synthetic checkpoint.` });
    messages.push({ role: 'assistant', content: 'ACK' });
  }
  messages.push({ role: 'user', content: `Turn ${turn + 1}: reply ACK.` });
  return {
    model, messages, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    max_completion_tokens: 512,
    reasoning_effort: 'minimal',
    tools: [{
      type: 'function', function: {
        name: 'inspect_fixture', description: 'Inspect a synthetic fixture; never needed for the acknowledgement.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      },
    }],
    tool_choice: 'none',
  };
}

async function main() {
  const [gateway, scenario, sessionsArg = '60', turnsArg = '6', rpmArg = '36', workersArg = '11'] = process.argv.slice(2);
  if (!['apim', 'aigateway'].includes(gateway) || !['single', 'balanced', 'sticky'].includes(scenario)) {
    throw new Error('Usage: node scripts/measure.mjs <apim|aigateway> <single|balanced|sticky> [sessions] [turns] [rpm] [workers]');
  }
  const sessions = Number(sessionsArg), turns = Number(turnsArg), rpm = Number(rpmArg), workers = Number(workersArg);
  if (![sessions, turns, rpm, workers].every(value => Number.isInteger(value) && value > 0) || sessions > 120 || turns > 10 || rpm > 120 || workers > 30) {
    throw new Error('Workload exceeds the bounded lab limits.');
  }
  const state = JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
  if (Date.now() - Date.parse(state.startedUtc) > 8 * 3600000) throw new Error('Lab lifetime limit exceeded; stop and clean up.');
  const run = `${gateway}-${scenario}-${randomUUID().slice(0, 8)}`;
  const folder = resolve('.lab', 'runs', run);
  await mkdir(folder, { recursive: true });
  const url = gateway === 'apim' ? `${state.apim.endpoint}/${scenario}/openai/v1/chat/completions` : state.aiGateway.chatUrl;
  if (!url) throw new Error('Gateway is not configured.');
  const model = gateway === 'apim' ? state.deployment : `${state.model}-${scenario}`;
  const key = gateway === 'apim' ? process.env.LAB_APIM_KEY : process.env.LAB_AIGATEWAY_KEY;
  if (!key) throw new Error('The required runtime credential is absent from the environment.');
  const keyHeader = gateway === 'apim' ? 'Ocp-Apim-Subscription-Key' : 'Authorization';
  const records = [];
  let nextStart = performance.now();
  let cursor = 0;
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function worker() {
    while (cursor < sessions) {
      const index = cursor++;
      const session = `ses_lab_${String(index).padStart(3, '0')}`;
      for (let turn = 0; turn < turns; turn++) {
        const slot = nextStart;
        nextStart += 60000 / rpm;
        await pause(Math.max(0, slot - performance.now()));
        let response;
        try {
          response = await callModel({ url, key, keyHeader, body: fixture(run, session, turn, model),
            session: scenario === 'balanced' ? null : session });
        } catch (error) {
          response = { complete: false, status: null, backend: 'unknown', error: error.message, totalMs: null };
        }
        if (typeof response.backend === 'string') {
          const label = response.backend.match(/(?:^|\/)(b[123])$/)?.[1];
          response.backend = label ?? (response.backend.includes('pool') ? 'unknown' : response.backend);
        }
        const expectedBackend = gateway === 'apim' && scenario === 'sticky' ? `b${backendIndex(session, model) + 1}` : null;
        const record = { gateway, scenario, run, session, turn, model, expectedBackend, ...response };
        records.push(record);
        await appendFile(resolve(folder, 'requests.jsonl'), `${JSON.stringify(record)}\n`);
        console.log(`${gateway} ${scenario} ${records.length}/${sessions * turns} ${response.status} ${response.backend} cached=${response.cachedTokens ?? '?'}`);
        if (records.filter(record => !record.complete).length >= 5) throw new Error('Stopped after five failed requests; inspect the saved evidence.');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, sessions) }, worker));
  const summary = { gateway, scenario, run, sessions, turns, rpm, workers: Math.min(workers, sessions),
    sessionHeadersSent: scenario !== 'balanced', ...summarize(records) };
  await writeFile(resolve(folder, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
