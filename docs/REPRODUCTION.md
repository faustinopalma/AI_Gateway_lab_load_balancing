# Reproducing the laboratory

This guide covers setup, execution, evidence collection, and cleanup. Start with the [README](../README.md) for the problem, architecture, and measured outcomes, or the [detailed report](REPORT.md) for the implemented configurations.

Run all commands from the repository root.

## Requirements

Use PowerShell 7, Azure CLI with the official `aigateway` extension, Bicep, Node.js 22+, and Git. GitHub CLI downloads the checksum-verified OpenCode binary.

Use an authorized lab subscription with sufficient model quota. Providers `Microsoft.ApiManagement`, `Microsoft.CognitiveServices`, `Microsoft.OperationalInsights`, and `Microsoft.Insights` must be registered. Obtain permission before registering subscription-wide providers.

The infrastructure is one APIM **Basic v2** unit, one standalone AI Gateway **Standard preview**, three Azure OpenAI accounts in Sweden Central, and capped telemetry. Each account deploys **gpt-5-nano**, version **2025-08-07**, deployment name **gpt-5-nano**, using **Global Standard** and 1,000,000 TPM / 1,000 RPM quota. Inference placement is service-managed.

Confirm current prices and a spending envelope before provisioning. APIM capacity is billed while it exists; inference and telemetry are billed separately. The lab uses pay-as-you-go capacity.

## Create and configure

Keep the Azure CLI profile outside the repository:

```powershell
$env:AZURE_CONFIG_DIR = '<authorized local Azure CLI profile>'
npm ci
npm test
.\scripts\New-Lab.ps1 -SubscriptionId '<subscription-id>' -CreateAiGateway
.\scripts\Set-Apim.ps1
.\scripts\Set-AiGateway.ps1
.\scripts\Set-Telemetry.ps1
.\scripts\Set-ModelDiagnostics.ps1
.\scripts\Wait-ModelDiagnostics.ps1
.\scripts\Install-OpenCode.ps1
```

Resources belong to a newly generated group tagged `purpose=llm-cache-affinity-lab`, `owner=fausto.palma`, and a unique lab identifier. Existing groups are never reused. Manifests, credentials, and raw evidence stay in the Git-ignored `.lab` directory.

The diagnostic-readiness step waits for independently matched requests from all three model accounts. [Initial diagnostic availability can take up to two hours](https://learn.microsoft.com/azure/ai-services/diagnostic-logging); keep this step before acceptance measurements.

Both gateways authenticate to models using managed identity. Model API-key authentication is disabled. Normal client-to-gateway credentials remain environment references.

### Routing configurations

| Case | APIM | Standalone AI Gateway |
|---|---|---|
| `single` | Prefer backend b1. | Alias with backend b1. |
| `balanced` | Equal-weight backend pool. | Equal-weight, equal-priority alias. |
| `sticky` | Policy hashes model and session identifier. | Alias enables native session affinity from `x-opencode-session`. |

APIM APIs expose `/{case}/openai/v1/chat/completions`. Backend entities are `b1`, `b2`, and `b3`; endpoint named values are `lab-endpoint-b1` through `lab-endpoint-b3`. API-level templates are in [policies](../policies/).

Standalone routing is in workspace `default`, providers `b1`/`b2`/`b3`, registration `lab-chat`, and aliases `gpt-5-nano-{case}`. Requests use `/default/models/openai/v1/chat/completions`, with the alias in `model`. [Set-AiGateway.ps1](../scripts/Set-AiGateway.ps1) sets and verifies `properties.sessionBackendPreference.key` and `properties.selectionOrder` through ARM.

OpenCode examples: [APIM](../examples/opencode-apim.json) and [AI Gateway](../examples/opencode-aigateway.json). Set `providers.lab.settings.baseURL`, the gateway credential reference, and `model`. Keep the Chat Completions provider package shown in the examples.

## Run the comparison

Run these commands in separate PowerShell processes, setting `AZURE_CONFIG_DIR` in each:

```powershell
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario single
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario balanced
.\scripts\Invoke-Measurements.ps1 -Gateway apim -Scenario sticky
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario single
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario balanced
.\scripts\Invoke-Measurements.ps1 -Gateway aigateway -Scenario sticky
```

Each case uses 60 six-turn sessions, eleven concurrent session workers, and 36 requests/minute, taking about ten minutes. Distinct early prompt prefixes separate the cases. The APIM single-backend route retains recovery; verify its measured distribution before accepting it as a strict reference.

### Client and edge checks

```powershell
node .\scripts\opencode-check.mjs mock
.\scripts\Invoke-OpenCode.ps1 -Gateway apim
.\scripts\Invoke-OpenCode.ps1 -Gateway aigateway
.\scripts\Invoke-OpenCode.ps1 -Gateway apim -Direct
.\scripts\Invoke-OpenCode.ps1 -Gateway aigateway -Direct
.\scripts\Invoke-EdgeChecks.ps1
.\scripts\Invoke-EdgeChecks.ps1 -Gateway aigateway
.\scripts\Invoke-EdgeChecks.ps1 -CacheScope
```

Observer mode forwards the unmodified OpenCode request through a local metadata recorder; direct mode uses ordinary provider settings. Checks validate completed responses, continued and new sessions, cookies, non-streaming requests, and missing-header behavior.

### Correlate, test recovery, and publish

Collect actual serving-account evidence from model logs. Allow time for diagnostic ingestion; enrichment exposes incomplete coverage.

```powershell
.\scripts\Get-LabLogs.ps1 `
  -Query 'AzureDiagnostics | where Category in ("RequestResponse", "AzureOpenAIRequestUsage") | summarize by CorrelationId, Resource' `
  -OutputName 'backend-correlations.json' | Out-Null
node .\scripts\enrich.mjs

.\scripts\Invoke-Faults.ps1 -Gateway apim
.\scripts\Invoke-Faults.ps1 -Gateway aigateway
```

Run recovery checks after the comparison and its enrichment. Native recovery checks select sessions whose preferred backends were independently verified. A b1-only alias checks that the backend is healthy before injection and actually returns the controlled error afterward. Tests temporarily change one lab endpoint, retain evidence, and restore it in `finally`. An unmet check returns a nonzero exit code; the [report](REPORT.md#pre-response-recovery) documents the native preview's current recovery boundary.

Repeat log collection and enrichment after recovery. Then:

```powershell
.\scripts\Remove-Lab.ps1 -ConfirmCleanup
node .\scripts\publish-results.mjs
node .\scripts\validate-results.mjs
```

Publication exports allowlisted fields and session ordinals, omitting credentials, resource IDs, hostnames, raw tracing IDs, and error bodies. Validation checks complete responses, independent backend evidence, session distribution, affinity, and cache-reference tolerance.

## Cleanup and sharing

Only run cleanup when authorized. [Remove-Lab.ps1](../scripts/Remove-Lab.ps1) checks ownership tags and the inventory against the manifest before deleting the dedicated group, then verifies absence. Unexpected resources stop deletion. Provider registrations and platform soft-delete records are retained.

Public repository: [faustinopalma/AI_Gateway_lab_load_balancing](https://github.com/faustinopalma/AI_Gateway_lab_load_balancing). Review sanitized outputs before publishing; never commit `.lab` or Azure token caches. No license is specified for the original lab content. Azure service artwork follows the [Azure architecture icon terms](https://learn.microsoft.com/azure/architecture/icons/).
