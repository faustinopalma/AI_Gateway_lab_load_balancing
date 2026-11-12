import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const variable = (name, expression) => `<set-variable name="${name}" value="${xml(expression)}" />`;
const header = (name, expression) => `<set-header name="${name}" exists-action="override"><value>${text(expression)}</value></set-header>`;

export function makePolicy(scenario, endpoints) {
  if (!['single', 'balanced', 'sticky'].includes(scenario) || endpoints.length !== 3) throw new Error('Invalid policy inputs.');
  const names = ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id'];
  const csharpNames = names.map(name => `"${name}"`).join(',');
  const validate = `@{
    string first = null;
    foreach (var name in new string[] { ${csharpNames} }) {
      string[] values;
      if (!context.Request.Headers.TryGetValue(name, out values)) { continue; }
      if (values.Length != 1) { return "Multiple session header values"; }
      var value = values[0];
      if (String.IsNullOrEmpty(value) || value.Length > 256 || !System.Text.RegularExpressions.Regex.IsMatch(value, "^[!-~]+$")) { return "Invalid session identifier"; }
      if (first != null && first != value) { return "Conflicting session identifiers"; }
      first = value;
    }
    return "";
  }`;
  const sessionName = `@{ foreach (var name in new string[] { ${csharpNames} }) { if (context.Request.Headers.ContainsKey(name)) { return name; } } return ""; }`;
  // The byte order matches the independent routing oracle; topology is fixed at three backends.
  const home = scenario === 'single' ? '@(0)' : `@{
    var session = (string)context.Variables["session"];
    if (String.IsNullOrEmpty(session)) { return new Random().Next(0, 3); }
    var model = (string)context.Request.Body.As<Newtonsoft.Json.Linq.JObject>(preserveContent: true)["model"];
    var bytes = System.Security.Cryptography.SHA256.Create().ComputeHash(System.Text.Encoding.UTF8.GetBytes("lab|" + model + "|" + session));
    uint number = 0;
    for (var i = 0; i < 4; i++) { number = (number << 8) | bytes[i]; }
    return (int)(number % 3);
  }`;
  const select = scenario === 'balanced'
    ? '<set-backend-service backend-id="pool" />'
    : `${variable('selected-backend', '@("b" + ((((int)context.Variables["home"] + (int)context.Variables["attempts"] - 1) % 3) + 1).ToString())')}
       <set-backend-service backend-id="${xml('@((string)context.Variables["selected-backend"])')}" />`;
  const backend = scenario === 'balanced'
    ? '@(context.Backend.Id.Substring(context.Backend.Id.LastIndexOf("/") + 1))'
    : '@((string)context.Variables["selected-backend"])';
  const urlExpression = `@((string)context.Variables["selected-backend"] == "b1" ? "${endpoints[0]}openai/v1/chat/completions" : (string)context.Variables["selected-backend"] == "b2" ? "${endpoints[1]}openai/v1/chat/completions" : "${endpoints[2]}openai/v1/chat/completions")`;
  return `<policies>
  <inbound>
    <base />
    ${variable('session-error', validate)}
    <choose><when condition="${xml('@(!String.IsNullOrEmpty((string)context.Variables["session-error"]))')}">
      <return-response><set-status code="400" reason="Invalid session headers" /><set-body>{"error":{"message":"Invalid or conflicting session headers"}}</set-body></return-response>
    </when></choose>
    ${variable('session-header', sessionName)}
    ${variable('session', '@(context.Request.Headers.GetValueOrDefault((string)context.Variables["session-header"], ""))')}
    ${variable('home', home)}
    ${variable('attempts', '@(0)')}
    ${variable('attempt-log', '@("")')}
    ${variable('attempt-path', '@("")')}
    ${variable('selected-backend', '@("pool")')}
    <authentication-managed-identity resource="https://cognitiveservices.azure.com" ignore-error="false" />
    <set-header name="Ocp-Apim-Subscription-Key" exists-action="delete" />
    <rewrite-uri template="/chat/completions" copy-unmatched-params="false" />
  </inbound>
  <backend>
    <retry condition="${xml('@(context.Response != null && (context.Response.StatusCode == 429 || context.Response.StatusCode >= 500))')}" count="2" interval="1" first-fast-retry="true">
      ${variable('attempts', '@((int)context.Variables["attempts"] + 1)')}
      ${select}
      ${variable('attempt-path', '@((string)context.Variables["attempt-path"] + (string)context.Variables["selected-backend"] + ";")')}
      <forward-request timeout="45" buffer-request-body="true" buffer-response="false" />
      ${variable('attempt-log', '@((string)context.Variables["attempt-log"] + (string)context.Variables["selected-backend"] + ":" + context.Response.StatusCode.ToString() + ";")')}
    </retry>
  </backend>
  <outbound>
    <base />
    ${header('x-lab-backend-request-id', '@(context.Response.Headers.GetValueOrDefault("apim-request-id", ""))')}
    ${header('x-lab-backend', backend)}
    ${header('x-lab-backend-type', '@(context.Backend.Type.ToString())')}
    ${header('x-lab-attempts', '@(((int)context.Variables["attempts"]).ToString())')}
    ${header('x-lab-session-header', '@((string)context.Variables["session-header"])')}
    ${header('x-lab-attempt-log', '@((string)context.Variables["attempt-log"])')}
    ${header('x-lab-attempt-path', '@((string)context.Variables["attempt-path"])')}
  </outbound>
  <on-error>
    <!-- A transport-recovery response is buffered; normal streaming remains unbuffered. -->
    <choose><when condition="${xml('@((context.LastError.Reason == "BackendConnectionFailure" || context.LastError.Reason == "Timeout") && (int)context.Variables["attempts"] < 3)')}">
      ${variable('attempt-log', '@((string)context.Variables["attempt-log"] + (string)context.Variables["selected-backend"] + ":" + context.LastError.Reason + ";")')}
      <retry condition="${xml('@((int)context.Variables["attempts"] < 3 && (context.Variables["recovery"] == null || ((IResponse)context.Variables["recovery"]).StatusCode == 429 || ((IResponse)context.Variables["recovery"]).StatusCode >= 500))')}" count="1" interval="1" first-fast-retry="true">
        ${variable('attempts', '@((int)context.Variables["attempts"] + 1)')}
        ${variable('selected-backend', '@("b" + ((((int)context.Variables["home"] + (int)context.Variables["attempts"] - 1) % 3) + 1).ToString())')}
        ${variable('attempt-path', '@((string)context.Variables["attempt-path"] + (string)context.Variables["selected-backend"] + ";")')}
        <send-request mode="copy" response-variable-name="recovery" timeout="45" ignore-error="true">
          <set-url>${text(urlExpression)}</set-url>
          <set-method>POST</set-method>
          <set-body>${text('@(context.Request.Body.As<string>(preserveContent: true))')}</set-body>
        </send-request>
        ${variable('attempt-log', '@((string)context.Variables["attempt-log"] + (string)context.Variables["selected-backend"] + ":" + (context.Variables["recovery"] == null ? "transport-error" : ((IResponse)context.Variables["recovery"]).StatusCode.ToString()) + ";")')}
      </retry>
      <choose><when condition="${xml('@(context.Variables["recovery"] != null)')}">
        <return-response response-variable-name="recovery">
          ${header('x-lab-backend', '@((string)context.Variables["selected-backend"])')}
          ${header('x-lab-attempts', '@(((int)context.Variables["attempts"]).ToString())')}
          ${header('x-lab-attempt-log', '@((string)context.Variables["attempt-log"])')}
          ${header('x-lab-attempt-path', '@((string)context.Variables["attempt-path"])')}
          ${header('x-lab-backend-request-id', '@(((IResponse)context.Variables["recovery"]).Headers.GetValueOrDefault("apim-request-id", ""))')}
          <set-header name="x-lab-recovery-buffered" exists-action="override"><value>true</value></set-header>
        </return-response>
      </when></choose>
    </when></choose>
    <return-response><set-status code="503" reason="Lab request failed" />${header('x-lab-error', '@(context.LastError.Reason)')}<set-body>{"error":{"message":"Gateway recovery exhausted or policy error; inspect lab diagnostics"}}</set-body></return-response>
  </on-error>
</policies>`;
}

if (process.argv[1]?.endsWith('policies.mjs')) {
  await mkdir(resolve('.lab', 'policies'), { recursive: true });
  await mkdir(resolve('policies'), { recursive: true });
  for (const scenario of ['single', 'balanced', 'sticky']) {
    const policy = makePolicy(scenario, [1, 2, 3].map(index => `{{lab-endpoint-b${index}}}/`));
    await writeFile(resolve('.lab', 'policies', `${scenario}.json`), JSON.stringify({ properties: { format: 'rawxml', value: policy } }));
    await writeFile(resolve('policies', `${scenario}.xml`), `${policy}\n`);
  }
}
