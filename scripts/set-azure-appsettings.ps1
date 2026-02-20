param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [Parameter(Mandatory = $false)]
  [string]$EnvFile = ".env_produccion",

  [switch]$DryRun
)

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI (az) no esta instalado o no esta en PATH."
}

if (-not (Test-Path -Path $EnvFile)) {
  throw "No existe el archivo de variables: $EnvFile"
}

$settings = @()
Get-Content -Path $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line) { return }
  if ($line.StartsWith("#")) { return }

  $separatorIndex = $line.IndexOf("=")
  if ($separatorIndex -lt 1) { return }

  $key = $line.Substring(0, $separatorIndex).Trim()
  $value = $line.Substring($separatorIndex + 1).Trim()
  if (-not $key) { return }

  $settings += "$key=$value"
}

if ($settings.Count -eq 0) {
  throw "No se encontraron pares KEY=VALUE en $EnvFile"
}

if ($DryRun) {
  Write-Host "Dry run. Se cargarian $($settings.Count) app settings en $AppName:"
  $settings | ForEach-Object { Write-Host " - $_" }
  exit 0
}

az webapp config appsettings set `
  --resource-group $ResourceGroup `
  --name $AppName `
  --settings @settings | Out-Null

Write-Host "App settings actualizadas en $AppName ($ResourceGroup): $($settings.Count)"
