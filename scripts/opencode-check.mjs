import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const gateway = process.argv[2] ?? 'mock';
const direct = process.argv[3] === 'direct';
if (!['mock', 'apim', 'aigateway'].includes(gateway)) throw new Error('Choose mock, apim, or aigateway.');
if (direct && gateway === 'mock') throw new Error('Direct mode needs a real gateway.');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const directory = resolve('.lab', 'opencode', direct ? `${gateway}-direct` : gateway, runId);
await mkdir(directory, { recursive: true });
const state = gateway === 'mock' ? null : JSON.parse(await readFile(resolve('.lab', 'state.json'), 'utf8'));
const model = gateway === 'aigateway' ? `${state.model}-sticky` : (state?.deployment ?? 'gpt-5-nano');
const key = gateway === 'apim' ? process.env.LAB_APIM_KEY : process.env.LAB_AIGATEWAY_KEY;
if (gateway !== 'mock' && !key) throw new Error('Runtime credential must be provided in the environment.');
const records = [];
const conversations = [];
const tool = JSON.parse(await readFile(resolve('.lab', 'opencode-tool.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const sessionHeaders = Object.fromEntries(
      ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']
        .filter(name => request.headers[name]).map(name => [name, request.headers[name]]));
    const record = {
      model: body.model, stream: body.stream, sessionHeaders,
      projectHash: request.headers['x-opencode-project'] ? hash(request.headers['x-opencode-project']) : null,
      cookieSent: Boolean(request.headers.cookie), requestBytes: Buffer.byteLength(raw),
      traceparentHash: request.headers.traceparent ? hash(request.headers.traceparent) : null,
    };
    records.push(record);
    if (gateway === 'mock') {
      record.status = 200;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'lab_probe=opaque; Path=/' });
      for (const data of [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'ACK' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 1, total_tokens: 2001, prompt_tokens_details: { cached_tokens: 0 } } },
      ]) response.write(`data: ${JSON.stringify({ id: 'chatcmpl-lab-mock', object: 'chat.completion.chunk', created: 1, model, ...data })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    const url = gateway === 'apim'
      ? `${state.apim.endpoint}/sticky/openai/v1/chat/completions`
      : state.aiGateway.chatUrl;
    const headers = { 'content-type': 'application/json' };
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.startsWith('x-opencode') || name.startsWith('x-session') || name === 'traceparent' || name === 'b3') headers[name] = value;
    }
    if (gateway === 'apim') headers['Ocp-Apim-Subscription-Key'] = key;
    else headers.authorization = `Bearer ${key}`;
    const upstream = await fetch(url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(180000) });
    record.status = upstream.status;
    record.backend = upstream.headers.get('x-lab-backend') ?? 'unknown';
    record.requestId = upstream.headers.get('apim-request-id');
    record.backendRequestId = upstream.headers.get('x-lab-backend-request-id');
    record.gatewaySessionHeader = upstream.headers.get('x-lab-session-header');
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch (error) {
    records.push({ error: error.message });
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Lab capture proxy failed.' } }));
  }
});
if (!direct) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = direct ? (gateway === 'apim' ? `${state.apim.endpoint}/sticky/openai/v1` :
  state.aiGateway.chatUrl.replace(/\/chat\/completions$/, '')) : `http://127.0.0.1:${server.address().port}/v1`;
const config = {
  $schema: 'https://opencode.ai/config.json',
  model: `lab/${model}`,
  small_model: `lab/${model}`,
  providers: {
    lab: {
      name: 'Isolated gateway laboratory',
      package: '@opencode/ai/providers/openai/chat',
      settings: { baseURL, apiKey: direct && gateway === 'aigateway' ? '{env:LAB_AIGATEWAY_KEY}' : 'local-proxy-only' },
      ...(direct && gateway === 'apim' ? { headers: { 'Ocp-Apim-Subscription-Key': '{env:LAB_APIM_KEY}' } } : {}),
      models: { [model]: { name: 'Lab model', body: { reasoning_effort: 'minimal', max_completion_tokens: 512 }, limit: { context: 128000, output: 2048 } } },
    },
  },
  policies: [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'lab', effect: 'allow' },
  ],
  permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  snapshots: false,
};
const configFile = resolve(directory, 'client-config.json');
await writeFile(configFile, JSON.stringify(config, null, 2));
const environment = {
  ...process.env,
  LAB_CLIENT_KEY: 'local-proxy-only',
  OPENCODE_CONFIG: configFile,
  XDG_CONFIG_HOME: resolve(directory, 'config'),
  XDG_DATA_HOME: resolve(directory, 'data'),
  XDG_CACHE_HOME: resolve(directory, 'cache'),
  XDG_STATE_HOME: resolve(directory, 'state'),
};
async function run(session) {
  const args = ['run', '--standalone', '--format', 'json', '--model', `lab/${model}`, '--title', 'Gateway laboratory'];
  if (session) args.push('--session', session);
  args.push('This is a gateway connectivity check. Reply only ACK. Do not use any tools or access files.');
  const child = spawn(tool.executable, args, {
    cwd: directory, env: environment, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 240000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timer);
  const index = conversations.length + 1;
  await writeFile(resolve(directory, `client-${index}.jsonl`), stdout);
  await writeFile(resolve(directory, `client-${index}.stderr.txt`), stderr);
  if (code !== 0) throw new Error(`OpenCode exited ${code}: ${stderr.slice(-1800)}`);
  const events = stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const id = events.map(event => event.sessionID ?? event.sessionId ?? event.session?.id).find(Boolean);
  const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('');
  const finished = events.some(event => event.type === 'step_finish' && event.part?.reason === 'stop');
  if (text.trim() !== 'ACK' || !finished || events.some(event => event.type === 'error')) {
    throw new Error('OpenCode did not finish with the expected acknowledgement.');
  }
  conversations.push({ session: id, resumed: Boolean(session), completed: true, version: tool.version, gateway, direct });
  console.log(`OpenCode ${gateway}: exit=${code}, events=${events.length}, session=${id ?? 'not found'}`);
  if (!id) throw new Error('OpenCode did not expose a session ID in JSON output.');
  return id;
}
try {
  const session = await run();
  await run(session);
  await run();
} finally {
  await writeFile(resolve(directory, 'request-metadata.json'), JSON.stringify(records, null, 2));
  await writeFile(resolve(directory, 'client-results.json'), JSON.stringify(conversations, null, 2));
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
console.log(JSON.stringify(records, null, 2));
if (!direct && (!records.length || records.some(record => record.error || record.status !== 200))) process.exitCode = 1;
