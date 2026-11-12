# LLM cache-affinity laboratory

Compare Azure API Management and the new standalone Azure AI Gateway using OpenCode and three identical model deployments. Measure whether independent sessions are distributed and each conversation stays on one backend without cookies.

**Results:** APIM provided cookie-free session affinity and recovered from the tested failures. The standalone gateway's tested pool switched backends within sessions and failed the isolated DNS-outage test. Cached-token reuse remained high with standard balancing too; a cache-saving advantage was not demonstrated with the tested Global Standard model.

- [Readable lab report](docs/REPORT.md)
- [Specification](SPECIFICATION.md)
- [Editable Inkscape diagram](docs/architecture.svg) and [PNG preview](docs/architecture.png)
- [Sanitized measured results](results/)

## Prerequisites

- PowerShell 7, Azure CLI, Bicep, Node.js 22 or later, and Git.
- The [official `aigateway` Azure CLI extension](https://learn.microsoft.com/azure/ai-gateway/get-started-cli); tested version: `1.0.0b26`.
- GitHub CLI for the exact official OpenCode installer. The tested client is **OpenCode 2.2.5**, downloaded from its GitHub release with checksum verification.
- An authorized laboratory subscription with model quota and registered `Microsoft.ApiManagement` / `Microsoft.CognitiveServices`.
- Confirm current pricing and your spending envelope before running. Basic v2 capacity is billed while it exists. Model inference and telemetry are billed separately.

## Reproduce the lab

Use an authorized local Azure CLI profile. Keep its directory outside the repository. Scripts use the explicit subscription stored in the private manifest.

```powershell
$env:AZURE_CONFIG_DIR = '<local Azure CLI profile directory>'
npm ci
npm test
.\scripts\New-Lab.ps1 -SubscriptionId '<subscription-id>' -CreateAiGateway
.\scripts\Set-Apim.ps1
.\scripts\Set-AiGateway.ps1
.\scripts\Set-Telemetry.ps1
.\scripts\Set-ModelDiagnostics.ps1
.\scripts\Install-OpenCode.ps1
```

Register `Microsoft.ApiManagement`, `Microsoft.CognitiveServices`, `Microsoft.OperationalInsights`, and `Microsoft.Insights` beforehand when needed. Provider registration changes the subscription; obtain authorization for it.

The default deployment is one APIM Basic v2 unit, a standalone Standard preview gateway, and three separate Azure OpenAI accounts in Sweden Central. Each account deploys `gpt-5-nano`, version `2025-08-07`, under the deployment name `gpt-5-nano`, using Global Standard. Physical inference placement is service-managed.

Each model deployment has 1,000,000 TPM / 1,000 RPM quota for the concurrent comparison. This is pay-as-you-go rate capacity. No PTU is allocated. Check availability and quota in your subscription before provisioning.

Resources use a newly generated group tagged `purpose=llm-cache-affinity-lab`, `owner=fausto.palma`, and a unique lab identifier. Existing groups are never reused. Resource IDs, endpoints, and local state remain under the Git-ignored `.lab` directory.

### Measurements

Run each command once, or run the six combinations in separate PowerShell processes. Set `AZURE_CONFIG_DIR` in every process. Each case takes approximately ten minutes:

```powershell
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario single -ConcurrentSessions 11
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario balanced -ConcurrentSessions 11
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario sticky -ConcurrentSessions 11
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario single -ConcurrentSessions 11
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario balanced -ConcurrentSessions 11
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario sticky -ConcurrentSessions 11
```

Defaults are 60 sessions, six turns, and 36 requests/minute per case. Turns remain ordered within each session. Standard-balancing cases omit session headers; affinity/probe cases send the four OpenCode headers. The standalone alias called `sticky` probes whether those headers influence routing; its configured pool has the same weights as `balanced`.

The APIM `single` route prefers b1 and retains the common recovery policy. Check its actual backend distribution before treating a run as a strict one-backend reference. The original measured reference served all 360 requests on b1; the later repeat recovered seven calls through other backends.

**Keep fault injection separate from comparison runs.** It temporarily changes a lab backend and can affect other aliases using that backend.

### Real client and focused checks

```powershell
node .\scripts\opencode-check.mjs mock
.\scripts\Invoke-OpenCode.ps1 -Gateway apim
.\scripts\Invoke-OpenCode.ps1 -Gateway aigateway
.\scripts\Invoke-OpenCode.ps1 -Gateway apim -Direct
.\scripts\Invoke-OpenCode.ps1 -Gateway aigateway -Direct
.\scripts\Invoke-EdgeChecks.ps1
.\scripts\Invoke-EdgeChecks.ps1 -CacheScope
.\scripts\Invoke-Faults.ps1 -Gateway apim
.\scripts\Invoke-Faults.ps1 -Gateway aigateway
.\scripts\Invoke-Faults.ps1 -Gateway aigateway -ColdTransportOnly
```

Observer mode forwards the unmodified model request through a loopback metadata recorder. Direct mode uses ordinary OpenCode provider settings. Each validation run keeps its own raw outputs and verifies the completed `ACK` response, session continuation, and a new session. The mock returns a cookie to test whether the client sends it back.

Fault scripts restore their endpoint in `finally`. A failed acceptance check returns a nonzero exit code and retains evidence. The isolated native transport probe is expected to fail on the tested preview: 12 requests returned HTTP 500. It creates a fresh provider/alias so earlier HTTP faults cannot pre-eject the primary backend.

### Exact configuration locations

| Item | Location |
|---|---|
| APIM endpoints | API paths `/single/openai/v1`, `/balanced/openai/v1`, `/sticky/openai/v1`; operation `/chat/completions`. |
| APIM policy | API-level `policy` on APIs `single`, `balanced`, and `sticky`; templates in [policies](policies/). |
| APIM model endpoints | Backend entities `b1`, `b2`, `b3`; pool `pool`; named values `lab-endpoint-b1`, `lab-endpoint-b2`, `lab-endpoint-b3`, populated from private state. |
| Native gateway routing | Workspace `default`; Foundry providers `b1`/`b2`/`b3`; model registration `lab-chat`; aliases `gpt-5-nano-single`, `gpt-5-nano-balanced`, `gpt-5-nano-sticky`. |
| Native client path | `/default/models/openai/v1/chat/completions`; request `model` selects the alias. |
| OpenCode APIM provider | [Example configuration](examples/opencode-apim.json): `providers.lab.settings.baseURL`, `providers.lab.headers.Ocp-Apim-Subscription-Key`, `model`. |
| OpenCode native provider | [Example configuration](examples/opencode-aigateway.json): `providers.lab.settings.baseURL`, `providers.lab.settings.apiKey`, `model`. |

Use the Chat Completions provider package shown in the examples. Client-to-gateway credentials are environment references; gateway-to-model authentication uses managed identity.

### Retain and publish evidence

Collect model diagnostics before deletion. Correlation is exact on the returned `apim-request-id`; unknown matches remain unknown. Wait for diagnostic ingestion if necessary.

```powershell
.\scripts\Get-LabLogs.ps1 `
  -Query 'AzureDiagnostics | where Category in ("RequestResponse", "AzureOpenAIRequestUsage") | summarize by CorrelationId, Resource' `
  -OutputName 'backend-correlations.json' | Out-Null
node .\scripts\enrich.mjs
.\scripts\Remove-Lab.ps1 -ConfirmCleanup
node .\scripts\publish-results.mjs
```

The publisher expects the complete measurement, client, edge, cache-scope, fault, and cleanup artifacts above. It exports allowlisted fields, replaces session identifiers with ordinals, and omits credentials, resource IDs, hostnames, raw tracing IDs, and error bodies. Original evidence remains private under `.lab`.

The checked-in results contain both full comparison rounds. The first used twelve concurrent sessions; the repeat used eleven to avoid accidental alignment with three-way round-robin scheduling. All six repeat cases have 100% serving-backend correlation coverage.

## Safety and sharing

- Gateway-to-model authentication uses managed identity. Model API keys are disabled.
- Runtime credentials, local OpenCode configuration, raw private evidence, and resource state are excluded from Git.
- Publish only reviewed, sanitized results. Never add Azure token caches or `.lab` to version control.
- Public repository: [faustinopalma/AI_Gateway_lab_load_balancing](https://github.com/faustinopalma/AI_Gateway_lab_load_balancing).
- No license is currently specified for the original lab content.

## Cleanup

After saving evidence, run:

```powershell
.\scripts\Remove-Lab.ps1 -ConfirmCleanup
```

The script checks the lab manifest, ownership tags, and every resource against the expected resource roots before deleting the dedicated group. Unexpected resources stop cleanup. Subscription-level provider registrations are retained. Platform soft-delete records are not purged.

The recorded execution's cleanup status is in [lifecycle evidence](results/lifecycle.json).

## References

- [Standalone Azure AI Gateway overview](https://learn.microsoft.com/azure/ai-gateway/overview)
- [Official AI Gateway CLI](https://github.com/Azure/aigateway/tree/main/cli)
- [API Management backends](https://learn.microsoft.com/azure/api-management/backends)
- [Azure OpenAI prompt caching](https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching)
