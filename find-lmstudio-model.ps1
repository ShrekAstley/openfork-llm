# Prints the id of the model LM Studio has loaded (nothing if it can't tell).
# Uses LM Studio's /api/v0/models, which reports load state; /v1/models only
# lists what is downloaded.
$ErrorActionPreference = 'Stop'
$base = if ($env:BRAIN_BASE_URL) { $env:BRAIN_BASE_URL } else { 'http://localhost:1234/v1' }
$root = $base -replace '/v1/?$', ''
try {
  $r = Invoke-RestMethod -Uri "$root/api/v0/models" -TimeoutSec 5
  $m = $r.data | Where-Object { $_.state -eq 'loaded' -and $_.type -ne 'embeddings' } | Select-Object -First 1
  if ($m) { $m.id }
} catch { }
