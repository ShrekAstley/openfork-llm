# Finds the model(s) LM Studio has loaded and writes the chosen id to -Out
# (empty file if it can't tell). With several loaded, asks which one to use.
# Uses LM Studio's /api/v0/models, which reports load state; /v1/models only
# lists what is downloaded.
param([Parameter(Mandatory = $true)][string]$Out)
$base = if ($env:BRAIN_BASE_URL) { $env:BRAIN_BASE_URL } else { 'http://localhost:1234/v1' }
$root = $base -replace '/v1/?$', ''
$ids = @()
try {
  $r = Invoke-RestMethod -Uri "$root/api/v0/models" -TimeoutSec 5
  $ids = @($r.data | Where-Object { $_.state -eq 'loaded' -and $_.type -ne 'embeddings' } | ForEach-Object { $_.id })
} catch { }
$pick = ''
if ($ids.Count -eq 1) { $pick = $ids[0] }
elseif ($ids.Count -gt 1) {
  Write-Host 'LM Studio has several models loaded:'
  for ($i = 0; $i -lt $ids.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $ids[$i]) }
  $n = Read-Host "Which one should the LLM nations use? [1]"
  $k = 0
  if (-not [int]::TryParse($n, [ref]$k) -or $k -lt 1 -or $k -gt $ids.Count) { $k = 1 }
  $pick = $ids[$k - 1]
}
Set-Content -Path $Out -Value $pick -NoNewline
