# Zamolxis installer (Windows).
#   powershell -ExecutionPolicy Bypass -File install.ps1            # install + build
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Web       # also enable the browser UI
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Web -Open # enable web UI and launch it now
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Service   # also register the logon service
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Local     # offer a menu of local models that fit this machine, then install your pick (asks first)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Local -Yes     # install the recommended model without prompting (unattended)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Local -Bigger  # default the menu to the largest model that still fits the GPU/RAM
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Local -Force   # offer/install even if the machine is below the recommended bar
#   powershell -ExecutionPolicy Bypass -File install.ps1 -SkipBuild
# ASCII only (PowerShell 5.1 reads .ps1 as Windows-1252).

param(
  [switch]$Web,
  [switch]$Open,
  [switch]$Service,
  [switch]$Local,
  [switch]$Bigger,
  [switch]$Yes,
  [switch]$Force,
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Set-EnvVar($text, $key, $val) {
  $line = "$key=$val"
  $pat = "(?m)^#?\s*" + [regex]::Escape($key) + "=.*$"
  if ([regex]::IsMatch($text, $pat)) { return [regex]::Replace($text, $pat, $line) }
  return $text.TrimEnd() + "`n" + $line + "`n"
}

# Install manifest: record ONLY what THIS installer adds (so `zamolxis uninstall` can reverse
# exactly that and leave anything that was already on the machine alone). Merged across runs.
$dataDir = if ($env:ZAMOLXIS_DATA_DIR) { $env:ZAMOLXIS_DATA_DIR } else { Join-Path $env:USERPROFILE ".zamolxis" }
$manifestPath = Join-Path $dataDir "install-manifest.json"
function Mark-Installed($key, $val) {
  $m = $null
  if (Test-Path $manifestPath) { try { $m = ConvertFrom-Json (Get-Content -Raw $manifestPath) } catch {} }
  if (-not $m) { $m = [pscustomobject]@{ installed = [pscustomobject]@{} } }
  if (-not $m.installed) { $m | Add-Member installed ([pscustomobject]@{}) -Force }
  $m.installed | Add-Member $key $val -Force
  $m | Add-Member updatedAt ((Get-Date).ToString("o")) -Force
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  ($m | ConvertTo-Json -Depth 6) | Set-Content -Encoding utf8 $manifestPath
}

Step "Checking prerequisites"
function Test-Cmd($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User') }
$haveWinget = Test-Cmd winget
if (-not $haveWinget) { Warn "winget not found - cannot auto-install missing prerequisites. Install them manually if the steps below fail." }

# git - needed to clone the repo and for the built-in self-update.
if (-not (Test-Cmd git)) {
  if ($haveWinget) {
    Step "Installing git (winget)"
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path; $env:Path += ";$env:ProgramFiles\Git\cmd"
  } else { Warn "git not found. Install it from https://git-scm.com" }
  if (Test-Cmd git) { Write-Host "    git installed"; Mark-Installed git $true } else { Warn "git still not on PATH - open a NEW terminal after install completes." }
} else { Write-Host "    git $((git --version).Split(' ')[-1])" }

# Node.js 20+ - required to build and run Zamolxis.
$nodeWasAbsent = -not (Test-Cmd node)
$needNode = $true
if (Test-Cmd node) {
  try { if ([int]((node -v).TrimStart('v').Split('.')[0]) -ge 20) { $needNode = $false } } catch {}
  if ($needNode) { Warn "Node $(node -v) is too old; need 20+." }
}
if ($needNode) {
  if ($haveWinget) {
    Step "Installing Node.js LTS (winget)"
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path; $env:Path += ";$env:ProgramFiles\nodejs"
  } else { throw "Node.js 20+ not found and winget is unavailable. Install Node 20+ from https://nodejs.org and re-run." }
}
if (-not (Test-Cmd node)) { throw "Node was installed but is not on PATH yet. Open a NEW terminal and re-run install.ps1." }
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node $(node -v) is too old; need 20+. Install a newer Node and re-run." }
# Only record Node as ours if it was entirely absent before (don't claim an upgrade of a pre-existing Node).
if ($needNode -and $nodeWasAbsent) { Mark-Installed node $true }
Write-Host "    Node $(node -v)"

# Claude Code CLI - the engine Zamolxis runs on (subscription via 'claude login').
if (-not (Test-Cmd claude)) {
  Step "Installing Claude Code CLI (npm)"
  try { npm install -g @anthropic-ai/claude-code 2>&1 | Out-Null } catch {}
  Refresh-Path
  if (Test-Cmd claude) { Mark-Installed claudeCode $true }
}
if (Test-Cmd claude) {
  $creds = Join-Path $env:USERPROFILE ".claude\.credentials.json"
  if (-not (Test-Path $creds)) { Warn "Claude Code is installed. Run 'claude login' with your Pro/Max account before starting." }
  else { Write-Host "    Claude credentials found" }
} else {
  Warn "Could not install the Claude Code CLI automatically. Install it, then run 'claude login' (Pro/Max) so Zamolxis can use your subscription."
}

Step "Installing dependencies (npm)"
if (Test-Path (Join-Path $root "package-lock.json")) { npm ci } else { npm install }

if (-not $SkipBuild) {
  Step "Building (tsc)"
  npm run build
}

Step "Bundled skills"
$seed = Join-Path $root "skills-seed"
if (Test-Path $seed) {
  $n = @(Get-ChildItem $seed -Directory).Count
  Write-Host "    $n skill(s) bundled - they seed into your skills dir automatically on first run."
} else { Warn "skills-seed folder missing - no skills will be seeded." }
$hermes = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\skills"
if (Test-Path $hermes) { Write-Host "    Hermes skill library detected - its skills are auto-discovered; browse + Import them in the web Skills panel." }

Step "Configuration"
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root ".env.example") $envFile
  Write-Host "    Created .env from .env.example"
  Warn "Edit .env to enable messaging channels (ZAMOLXIS_CHANNEL_*) and add their tokens."
} else {
  Write-Host "    .env already exists (left as-is)"
}

# Web interface
$enc = New-Object System.Text.UTF8Encoding($false)
$webPort = "8787"
$envText = [System.IO.File]::ReadAllText($envFile)
$m = [regex]::Match($envText, 'ZAMOLXIS_WEB_PORT=(\d+)')
if ($m.Success) { $webPort = $m.Groups[1].Value }
if ($Web) {
  Step "Enabling web interface"
  if ($envText -match 'ZAMOLXIS_CHANNEL_WEB=false') {
    $envText = $envText -replace 'ZAMOLXIS_CHANNEL_WEB=false', 'ZAMOLXIS_CHANNEL_WEB=true'
  } elseif ($envText -notmatch 'ZAMOLXIS_CHANNEL_WEB=') {
    $envText = $envText.TrimEnd() + "`nZAMOLXIS_CHANNEL_WEB=true`n"
  } else {
    $envText = $envText -replace 'ZAMOLXIS_CHANNEL_WEB=true', 'ZAMOLXIS_CHANNEL_WEB=true'
  }
  [System.IO.File]::WriteAllText($envFile, $envText, $enc)
  Write-Host "    Web channel enabled (local: http://127.0.0.1:$webPort)"
  Warn "To reach it from other machines, set ZAMOLXIS_WEB_BIND and ZAMOLXIS_WEB_AUTH_TOKEN in .env."
}

# Local model (free on-device offload for easy tasks)
Step "Local model"
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
# Enumerate ALL GPUs (a laptop often has an Intel iGPU AND a dedicated NVIDIA/AMD card).
$allGpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
# A dedicated CUDA/ROCm GPU lets Ollama run far faster; detect it by name.
$dedicated = $allGpus | Where-Object { $_ -match 'NVIDIA|GeForce|RTX|Quadro|Tesla|Radeon RX|Radeon Pro|\bArc\b' } | Select-Object -First 1
$hasGpu = [bool]$dedicated
# VRAM: nvidia-smi is authoritative; else registry qwMemorySize (Win32_VideoController.AdapterRAM is uint32-capped at 4GB - unreliable).
$vram = 0
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  try { $mib = (nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Select-Object -First 1); if ($mib) { $vram = [math]::Round([int]$mib / 1024) } } catch {}
}
if ($vram -eq 0) {
  try {
    Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*' -ErrorAction SilentlyContinue |
      ForEach-Object { $q = $_.'HardwareInformation.qwMemorySize'; if ($q) { $g = [math]::Round($q / 1GB); if ($g -gt $vram) { $vram = $g } } }
  } catch {}
}
$gpuLabel = if ($dedicated) { "$dedicated (~${vram}GB VRAM)" } elseif ($allGpus.Count) { "$($allGpus[0]) (integrated)" } else { "none" }
Write-Host "    Detected: ${ramGB}GB RAM, GPU: $gpuLabel"
# Memory budget for model sizing. With a CUDA/ROCm GPU, Ollama offloads layers to VRAM,
# so size to VRAM; on CPU, keep ~half the RAM for the OS + app (and CPU inference is slow).
$effCap = if ($hasGpu) { $vram } else { [math]::Floor($ramGB / 2) }
# "Powerful enough" = a dedicated GPU, or >=8GB system RAM. Below that, a local model is
# too weak/slow to be worth it, so we don't install it (even with -Local) unless -Force.
$capable = $hasGpu -or ($ramGB -ge 8)
if ($hasGpu) { Write-Host "    Dedicated GPU detected - models will be GPU-accelerated." }

# Curated catalog (small -> large). Need = approx GB to run the Q4 build comfortably.
# We only OFFER the models that fit this machine, each with a one-line strength.
$catalog = @(
  @{ Id = 'qwen2.5:1.5b';      Need = 2;  Str = 'tiny & fast - fine for routing / simple offload' }
  @{ Id = 'llama3.2:3b';       Need = 4;  Str = 'fast, lightweight general chat; broad knowledge' }
  @{ Id = 'qwen2.5:3b';        Need = 4;  Str = 'strong tool use for its size - solid small default' }
  @{ Id = 'qwen2.5-coder:7b';  Need = 6;  Str = 'tuned for code: generation, review, refactors' }
  @{ Id = 'qwen2.5:7b';        Need = 6;  Str = 'best all-round: instruction following + tool use' }
  @{ Id = 'deepseek-r1:8b';    Need = 7;  Str = 'step-by-step reasoning & math (thinks first, slower)' }
  @{ Id = 'qwen2.5:14b';       Need = 10; Str = 'noticeably smarter, broader knowledge - slower' }
  @{ Id = 'qwen2.5-coder:14b'; Need = 10; Str = 'strongest coding model that fits a large GPU' }
  @{ Id = 'qwen2.5:32b';       Need = 22; Str = 'smartest local option - needs a big GPU' }
)
$fit = @($catalog | Where-Object { $_.Need -le $effCap })
if (-not $fit.Count) { $fit = @($catalog[0]) }   # tiny machines: at least the 1.5b
# Recommended = the largest general qwen2.5 that fits (the well-rounded default for Zamolxis).
$recId = ($fit | Where-Object { $_.Id -match '^qwen2\.5:' } | Select-Object -Last 1).Id
if (-not $recId) { $recId = $fit[-1].Id }
$defaultId = if ($Bigger) { $fit[-1].Id } else { $recId }

function Show-ModelMenu {
  Write-Host "    Local models that fit this machine (~${effCap}GB budget):"
  for ($i = 0; $i -lt $fit.Count; $i++) {
    $m = $fit[$i]
    $tag = if ($m.Id -eq $recId) { '  <- recommended' } else { '' }
    Write-Host ("      [{0}] {1,-17} {2}{3}" -f ($i + 1), $m.Id, $m.Str, $tag)
  }
}

$model = $defaultId
$shouldInstall = $false
if ($Local) {
  if (-not $capable -and -not $Force) {
    Warn "This machine isn't powerful enough for a useful local model (needs a dedicated GPU or >=8GB RAM)."
    Warn "Skipping local-model install; the subscription will handle everything. Use -Local -Force to override."
  } else {
    if (-not $capable) { Warn "Below the recommended bar, but -Force was given; offering small models anyway." }
    Show-ModelMenu
    # Ask the user to pick one before installing (a local model is a multi-GB download + service).
    if ($Yes) {
      $shouldInstall = $true
      Write-Host "    -Yes: installing the default model '$model'."
    } elseif ([Environment]::UserInteractive) {
      $ans = Read-Host "    Pick a model [1-$($fit.Count), Enter = '$defaultId', or 's' to skip]"
      $ans = $ans.Trim()
      if ($ans -match '^(s|skip|n|no)$') {
        Write-Host "    Skipped local-model install."
      } elseif ($ans -eq '') {
        $model = $defaultId; $shouldInstall = $true
      } elseif ($ans -match '^\d+$' -and [int]$ans -ge 1 -and [int]$ans -le $fit.Count) {
        $model = $fit[[int]$ans - 1].Id; $shouldInstall = $true
      } elseif ($fit | Where-Object { $_.Id -eq $ans }) {
        $model = $ans; $shouldInstall = $true
      } else {
        Warn "Unrecognized choice '$ans'; using default '$defaultId'."
        $model = $defaultId; $shouldInstall = $true
      }
    } else {
      Warn "Non-interactive shell and no -Yes; skipping local-model install. Re-run with -Local -Yes to install the default unattended."
    }
  }
} else {
  if ($capable) {
    Show-ModelMenu
    Write-Host "    Re-run with -Local to choose one and set it up (Ollama + the model). Add -Yes to take the recommended unattended."
  } else {
    Write-Host "    This machine is below the bar for a useful local model; the subscription will handle everything."
    Write-Host "    (-Local -Force would still let you pick a small one if you really want it.)"
  }
}

if ($shouldInstall) {
  $ollamaWasAbsent = -not (Get-Command ollama -ErrorAction SilentlyContinue)
  if ($ollamaWasAbsent) {
    Step "Installing Ollama"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
      $env:Path += ";$env:LOCALAPPDATA\Programs\Ollama"
      Start-Sleep -Seconds 3
      if (Get-Command ollama -ErrorAction SilentlyContinue) { Mark-Installed ollama $true }
    } else {
      Warn "winget not available. Install Ollama from https://ollama.com then re-run with -Local."
    }
  }
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Step "Pulling model $model (one-time download, ~1-2 GB)"
    ollama pull $model
    Mark-Installed model $model
    $envText = [System.IO.File]::ReadAllText($envFile)
    $envText = Set-EnvVar $envText 'ZAMOLXIS_LOCAL_MODEL' $model
    $envText = Set-EnvVar $envText 'ZAMOLXIS_LOCAL_MODEL_URL' 'http://localhost:11434/v1'
    [System.IO.File]::WriteAllText($envFile, $envText, $enc)
    Write-Host "    Configured local model for easy-task offload: $model"
    Step "Verifying local model"
    try {
      $body = (@{ model = $model; stream = $false; messages = @(@{ role = 'user'; content = 'Reply with OK' }) } | ConvertTo-Json -Compress)
      Invoke-WebRequest "http://localhost:11434/v1/chat/completions" -Method POST -Body $body -ContentType 'application/json' -TimeoutSec 90 -UseBasicParsing | Out-Null
      Write-Host "    Local model responding - offload ready."
    } catch {
      Warn "Local model not responding yet; Ollama may still be starting. It will be used once available."
    }
  }
}

if ($Service) {
  Step "Registering logon service"
  & (Join-Path $root "scripts\service-install.ps1")
  Mark-Installed service $true
}

Step "Readiness check"
try { node "dist\index.js" --doctor } catch { Warn "doctor reported issues (see above)" }

Write-Host ""
Write-Host "Zamolxis installed." -ForegroundColor Green
Write-Host "  Interactive:  npm run cli"
Write-Host "  Web UI:       npm run web   then open http://127.0.0.1:$webPort"
Write-Host "  Background:   npm start   (or, with -Service: npm run service:start)"
Write-Host "  Re-check:     npm run doctor"

if ($Web -and $Open) {
  Step "Launching web interface"
  Start-Process node -ArgumentList "--enable-source-maps dist\index.js --channels=web" -WorkingDirectory $root
  Start-Sleep -Seconds 3
  Start-Process "http://127.0.0.1:$webPort"
  Write-Host "    Opened http://127.0.0.1:$webPort in your browser."
}
