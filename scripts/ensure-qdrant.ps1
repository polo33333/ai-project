function Ensure-QdrantDocker {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot,
          [Parameter(Mandatory = $true)][string]$QdrantUrl)
    $qdrantEndpoint = [Uri]$QdrantUrl
    if (-not $qdrantEndpoint.IsLoopback) {
        if (-not (Test-HttpEndpoint "$QdrantUrl/collections")) { throw 'External Qdrant is unavailable.' }
        Write-Host '[OK] External Qdrant is ready.'
        return
    }
    Ensure-StartupDocker
    Write-Host '[Startup] Ensuring Qdrant Docker container is running...'
    if ((Invoke-StartupDocker -DockerArguments @('container', 'inspect', 'knowledgehub-qdrant')) -eq 0) {
        if ((Invoke-StartupDocker -DockerArguments @('start', 'knowledgehub-qdrant')) -ne 0) {
            throw 'Cannot start Qdrant container. Check Docker status and port conflicts.'
        }
    } else {
        $composeFile = Join-Path $ProjectRoot 'compose.postgres.yml'
        $postgresEnv = Join-Path $ProjectRoot '.env.postgres'
        if (-not (Test-Path -LiteralPath $composeFile) -or -not (Test-Path -LiteralPath $postgresEnv)) {
            throw 'compose.postgres.yml and .env.postgres are required to create Qdrant.'
        }
        if ((Invoke-StartupDocker -DockerArguments @('compose', '--project-directory', $ProjectRoot, '--env-file', $postgresEnv, '-f', $composeFile, 'up', '-d', '--no-deps', 'qdrant')) -ne 0) {
            throw 'Cannot create Qdrant container. Check Compose configuration and port conflicts.'
        }
    }
    Write-Host '[Startup] Waiting for Qdrant API...'
    $qdrantDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $qdrantDeadline) {
        if (Test-HttpEndpoint "$QdrantUrl/collections") {
            Write-Host '[OK] Qdrant Docker is ready.'
            return
        }
        Start-Sleep -Seconds 1
    }
    throw 'Qdrant did not become ready within 90 seconds. Backend startup cancelled.'
}
