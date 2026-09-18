# Native errors are captured without printing connection settings/secrets.
function Invoke-StartupDocker {
    param([string[]]$DockerArguments)
    $ErrorActionPreference = 'Continue'
    try {
        & docker @DockerArguments *> $null
        return $LASTEXITCODE
    } catch { return 1 }
}

function Ensure-PostgresDocker {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI was not found. Install Docker Desktop and reopen the terminal.'
    }
    if ((Invoke-StartupDocker -DockerArguments @('info')) -ne 0) {
        Write-Host '[Startup] Starting Docker Desktop...'
        $desktopCandidates = @(
            (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
            (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
        )
        $desktopExe = $desktopCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($desktopExe) {
            Start-Process -FilePath $desktopExe -WindowStyle Hidden | Out-Null
        } elseif ((Invoke-StartupDocker -DockerArguments @('desktop', 'start')) -ne 0) {
            throw 'Cannot start Docker Desktop. Open Docker Desktop and try npm start again.'
        }
        $dockerReady = $false
        $dockerDeadline = [DateTime]::UtcNow.AddSeconds(120)
        while ([DateTime]::UtcNow -lt $dockerDeadline) {
            if ((Invoke-StartupDocker -DockerArguments @('info')) -eq 0) { $dockerReady = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $dockerReady) { throw 'Docker did not become ready within 120 seconds.' }
    }
    Write-Host '[OK] Docker is ready.'
    $postgresContainer = if ($env:APP_PG_DOCKER_CONTAINER) { $env:APP_PG_DOCKER_CONTAINER } else { 'knowledgehub-postgres' }
    if ((Invoke-StartupDocker -DockerArguments @('container', 'inspect', $postgresContainer)) -eq 0) {
        Write-Host '[Startup] Ensuring PostgreSQL container is running...'
        if ((Invoke-StartupDocker -DockerArguments @('start', $postgresContainer)) -ne 0) {
            throw 'Cannot start PostgreSQL container. Check Docker container status and port conflicts.'
        }
    } else {
        if ($postgresContainer -ne 'knowledgehub-postgres') { throw 'Configured PostgreSQL container does not exist. Create it before starting the app.' }
        $composeFile = Join-Path $ProjectRoot 'compose.postgres.yml'
        $postgresEnv = Join-Path $ProjectRoot '.env.postgres'
        if (-not (Test-Path -LiteralPath $composeFile) -or -not (Test-Path -LiteralPath $postgresEnv)) {
            throw 'compose.postgres.yml and .env.postgres are required to create PostgreSQL.'
        }
        Write-Host '[Startup] Creating PostgreSQL container from Compose...'
        if ((Invoke-StartupDocker -DockerArguments @('compose', '--project-directory', $ProjectRoot, '--env-file', $postgresEnv, '-f', $composeFile, 'up', '-d', 'postgres')) -ne 0) {
            throw 'Cannot create PostgreSQL container. Check Compose configuration, image access and port conflicts.'
        }
    }
    Write-Host '[Startup] Waiting for PostgreSQL...'
    $postgresDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $postgresDeadline) {
        if ((Invoke-StartupDocker -DockerArguments @('exec', $postgresContainer, 'pg_isready', '-h', '127.0.0.1', '-p', '5432')) -eq 0) {
            Write-Host '[OK] PostgreSQL is ready.'
            return
        }
        Start-Sleep -Seconds 1
    }
    throw 'PostgreSQL did not become ready within 90 seconds. Backend startup cancelled.'
}
