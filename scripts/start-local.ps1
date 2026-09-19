$ErrorActionPreference = 'Stop'

# ============================================
# PROJECT PATH
# ============================================

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'


# ============================================
# LOAD .ENV FILE
# ============================================

foreach ($startupEnvFile in @($envFile, (Join-Path $projectRoot '.env.postgres'))) {
if (Test-Path -LiteralPath $startupEnvFile) {
    foreach ($line in Get-Content -LiteralPath $startupEnvFile -Encoding utf8) {

        # Ignore empty lines and comments
        if ($line -match '^\s*$' -or $line -match '^\s*#') {
            continue
        }

        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim([char]34, [char]39)

            # Only set if environment variable does not already exist
            if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
                [Environment]::SetEnvironmentVariable(
                    $name,
                    $value,
                    'Process'
                )
            }
        }
    }
}
}

# ============================================
# CONFIGURATION
# ============================================

$embeddingProvider = if ($env:EMBEDDING_PROVIDER) {
    $env:EMBEDDING_PROVIDER.ToLowerInvariant()
} else {
    'ollama'
}


# Embedding Model
$embeddingModel = if ($env:EMBEDDING_MODEL) {
    $env:EMBEDDING_MODEL
} else {
    'bge-m3'
}


# Main Local AI Model
$localAiModel = if ($env:LOCAL_AI_MODEL) {
    $env:LOCAL_AI_MODEL
} else {
    'qwen3.5:9b'
}


# Ollama URL
$embeddingBaseUrl = if ($env:EMBEDDING_BASE_URL) {
    $env:EMBEDDING_BASE_URL.TrimEnd('/')
} else {
    'http://127.0.0.1:11434'
}


# Qdrant URL
$qdrantUrl = if ($env:QDRANT_URL) {
    $env:QDRANT_URL.TrimEnd('/')
} else {
    'http://127.0.0.1:6333'
}


# ============================================
# HTTP ENDPOINT CHECK
# ============================================

function Test-HttpEndpoint {
    param(
        [string]$url
    )

    try {
        Invoke-RestMethod `
            -Uri $url `
            -Method Get `
            -TimeoutSec 2 | Out-Null

        return $true

    } catch {
        return $false
    }
}


# ============================================
# CHECK OLLAMA MODEL
# ============================================

function Test-OllamaModelInstalled {
    param(
        [string]$ModelName,
        [array]$InstalledModels
    )

    foreach ($model in $InstalledModels) {

        # Exact match
        if ($model -eq $ModelName) {
            return $true
        }

        # Handle :latest
        if ($model -eq "${ModelName}:latest") {
            return $true
        }

        # If requested model already contains a tag,
        # also compare base name where appropriate
        if ($ModelName.EndsWith(':latest')) {

            $baseModelName = $ModelName.Substring(
                0,
                $ModelName.Length - ':latest'.Length
            )

            if ($model -eq $baseModelName) {
                return $true
            }
        }
    }

    return $false
}


# ============================================
# ENSURE OLLAMA MODEL
# ============================================

function Ensure-OllamaModel {
    param(
        [string]$ModelName,
        [string]$ModelType,
        [string]$OllamaExe,
        [string]$OllamaBaseUrl
    )

    Write-Host ""
    Write-Host "[Startup] Checking $ModelType model: $ModelName"

    # Get latest installed model list
    $tags = Invoke-RestMethod `
        -Uri "$OllamaBaseUrl/api/tags" `
        -Method Get `
        -TimeoutSec 10

    $installedModels = @(
        $tags.models | ForEach-Object {
            $_.name
        }
    )

    $modelExists = Test-OllamaModelInstalled `
        -ModelName $ModelName `
        -InstalledModels $installedModels


    if ($modelExists) {

        Write-Host "[OK] $ModelType model is installed: $ModelName"
        return
    }


    Write-Host "[Startup] $ModelType model not found: $ModelName"
    Write-Host "[Startup] Pulling model..."

    & $OllamaExe pull $ModelName


    if ($LASTEXITCODE -ne 0) {
        throw "Unable to pull $ModelType model: $ModelName"
    }


    Write-Host "[OK] $ModelType model downloaded successfully: $ModelName"
}


# ============================================
# DOCKER SERVICES
# ============================================

Write-Host ""
Write-Host "========================================"
Write-Host "        DOCKER SERVICES STARTUP"
Write-Host "========================================"

# Check PostgreSQL and Qdrant together before starting models and the backend.
. (Join-Path $PSScriptRoot 'ensure-postgres.ps1')
if ($env:APP_STORAGE_BACKEND -eq 'postgres') {
    $postgresHost = if ($env:APP_PG_HOST) { $env:APP_PG_HOST } else { '127.0.0.1' }
    if ($postgresHost -in @('127.0.0.1', 'localhost', '::1')) {
        Ensure-PostgresDocker -ProjectRoot $projectRoot
    } else {
        Write-Host '[Startup] PostgreSQL uses an external host; local Docker startup skipped.'
    }
}

. (Join-Path $PSScriptRoot 'ensure-qdrant.ps1')
Ensure-QdrantDocker -ProjectRoot $projectRoot -QdrantUrl $qdrantUrl


# ============================================
# OLLAMA
# ============================================

if ($embeddingProvider -eq 'ollama') {

    Write-Host ""
    Write-Host "========================================"
    Write-Host "           OLLAMA STARTUP"
    Write-Host "========================================"


    # Find Ollama executable
    $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue


    $ollamaExe = if ($ollamaCommand) {

        $ollamaCommand.Source

    } else {

        Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    }


    if (-not (Test-Path -LiteralPath $ollamaExe)) {

        throw @"
Ollama was not found.

Please install Ollama or add ollama.exe to PATH.

Expected location:
$ollamaExe
"@
    }


    # ============================================
    # START OLLAMA IF NOT RUNNING
    # ============================================

    if (-not (Test-HttpEndpoint "$embeddingBaseUrl/api/tags")) {

        Write-Host '[Startup] Ollama is offline.'
        Write-Host '[Startup] Starting Ollama...'

        Start-Process `
            -FilePath $ollamaExe `
            -ArgumentList 'serve' `
            -WindowStyle Hidden


        $ollamaReady = $false


        for ($attempt = 1; $attempt -le 30; $attempt++) {

            Start-Sleep -Milliseconds 500


            if (Test-HttpEndpoint "$embeddingBaseUrl/api/tags") {

                $ollamaReady = $true
                break
            }
        }


        if (-not $ollamaReady) {

            throw "Ollama did not become ready at $embeddingBaseUrl within 15 seconds."
        }

    } else {

        Write-Host '[OK] Ollama is already running.'
    }


    # ============================================
    # CHECK EMBEDDING MODEL
    # ============================================

    Ensure-OllamaModel `
        -ModelName $embeddingModel `
        -ModelType 'Embedding' `
        -OllamaExe $ollamaExe `
        -OllamaBaseUrl $embeddingBaseUrl


    # ============================================
    # CHECK LOCAL AI MODEL
    # ============================================

    Ensure-OllamaModel `
        -ModelName $localAiModel `
        -ModelType 'Local AI' `
        -OllamaExe $ollamaExe `
        -OllamaBaseUrl $embeddingBaseUrl


    # ============================================
    # WARM-UP EMBEDDING MODEL
    # ============================================

    Write-Host ""
    Write-Host "[Startup] Warming up embedding model: $embeddingModel"


    $warmupBody = @{
        model = $embeddingModel
        input = 'KnowledgeHub startup warmup'
    } | ConvertTo-Json


    try {

        Invoke-RestMethod `
            -Uri "$embeddingBaseUrl/api/embed" `
            -Method Post `
            -ContentType 'application/json' `
            -Body $warmupBody `
            -TimeoutSec 120 | Out-Null


        Write-Host "[OK] Embedding model is ready: $embeddingModel"

    } catch {

        Write-Warning "Embedding model warm-up failed: $($_.Exception.Message)"
    }


    # ============================================
    # LOCAL AI MODEL STATUS
    # ============================================

    Write-Host "[OK] Local AI model is ready: $localAiModel"
    Write-Host "[Startup] Local AI model will load when requested."
}


# ============================================
# START KNOWLEDGEHUB
# ============================================

Write-Host ""
Write-Host "========================================"
Write-Host "       STARTING KNOWLEDGEHUB"
Write-Host "========================================"

Write-Host "[Startup] Project: $projectRoot"
Write-Host "[Startup] Embedding Model: $embeddingModel"
Write-Host "[Startup] Local AI Model: $localAiModel"

Write-Host ""
Write-Host '[Startup] Starting KnowledgeHub...'

Set-Location -LiteralPath $projectRoot


& node scripts/supervisor.js


exit $LASTEXITCODE
