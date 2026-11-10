# Start one isolated MySQL instance and the 0.2 API on loopback.
[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9_-]{1,32}$')][string]$Instance = 'dev',
    [ValidateRange(1024, 65535)][int]$ApiPort = 8080,
    [ValidateRange(1024, 65535)][int]$DbPort = 33316,
    [string]$MysqlBin,
    [string]$JavaExe,
    [string]$JarPath,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$state = Join-Path $repo ".tcw-local\$Instance"
$lockFile = Join-Path $state 'run.lock'
$stopFile = Join-Path $state 'stop.request'
if ($Stop) {
    if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) { Write-Host '该本机实例未运行。'; return }
    try { $probeLock = [IO.File]::Open($lockFile, 'Open', 'ReadWrite', 'None') }
    catch [IO.IOException] {
        [IO.File]::WriteAllText($stopFile, 'stop')
        Write-Host '已请求停止本机协作服务和它自己的数据库。'
        return
    }
    $probeLock.Dispose()
    Write-Host '该本机实例未运行。'
    return
}
if (-not $JavaExe) { $JavaExe = (Get-Command java.exe -ErrorAction Stop).Source }
if (-not $MysqlBin) { $MysqlBin = Split-Path -Parent (Get-Command mysqld.exe -ErrorAction Stop).Source }
if (-not $JarPath) { $JarPath = Join-Path $repo 'server\target\tcw-server-0.2.0.jar' }
$JarPath = (Resolve-Path -LiteralPath $JarPath -ErrorAction Stop).Path
$mysqlExe = Join-Path $MysqlBin 'mysql.exe'
$mysqlAdmin = Join-Path $MysqlBin 'mysqladmin.exe'
$mysqlDaemon = Join-Path $MysqlBin 'mysqld.exe'
foreach ($binary in @($mysqlExe,$mysqlAdmin,$mysqlDaemon,$JavaExe)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "找不到运行程序：$binary" }
}
if ($ApiPort -eq $DbPort) { throw '服务端口和数据库端口必须不同。' }

function Assert-PortFree([int]$port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() }
    catch { throw "本机端口 $port 已被占用，请用 -ApiPort 或 -DbPort 指定其他端口。" }
    finally { $listener.Stop() }
}
function New-Secret {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Write-Utf8([string]$file, [string]$content) {
    [IO.File]::WriteAllText($file, $content, [Text.UTF8Encoding]::new($false))
}

$null = New-Item -ItemType Directory -Force -Path $state
$lock = [IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
$database = $null
$java = $null
$rootIni = $null
$initSql = $null
$oldEnv = @{}
try {
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
    Assert-PortFree $ApiPort
    Assert-PortFree $DbPort
    $data = Join-Path $state 'mysql-data'
    $credsPath = Join-Path $state 'database-private.json'
    if (-not (Test-Path -LiteralPath $credsPath)) {
        if (Test-Path -LiteralPath $data) { throw '找不到该数据库的本机凭据。请保留原目录，并用新的 -Instance 名称启动。' }
        Write-Utf8 $credsPath (@{ root = (New-Secret); app = (New-Secret) } | ConvertTo-Json)
    }
    $creds = Get-Content -Raw -LiteralPath $credsPath | ConvertFrom-Json
    if ($creds.root -notmatch '^[0-9a-f]{48}$' -or $creds.app -notmatch '^[0-9a-f]{48}$') {
        throw '本机数据库凭据文件格式异常，未修改数据。'
    }
    $mysqlHome = Split-Path -Parent $MysqlBin
    $log = Join-Path $state 'mysql.log'
    $common = @('--no-defaults', ('--basedir="{0}"' -f $mysqlHome), ('--datadir="{0}"' -f $data), ('--log-error="{0}"' -f $log))
    if (-not (Test-Path -LiteralPath (Join-Path $data 'mysql'))) {
        if (Test-Path -LiteralPath $data) { throw "数据库初始化目录不完整，请保留 $data 后用新的 -Instance 名称重试。" }
        Write-Host '首次启动：正在初始化独立 MySQL 数据目录…'
        $initial = Start-Process -FilePath $mysqlDaemon -ArgumentList ($common + '--initialize-insecure') -WindowStyle Hidden -Wait -PassThru
        if ($initial.ExitCode -ne 0) { throw "MySQL 初始化失败，请查看 $log" }
    }
    $rootIni = Join-Path $state 'root-client.tmp'
    Write-Utf8 $rootIni ("[client]" + [Environment]::NewLine + "user=root" + [Environment]::NewLine + "password=$($creds.root)" + [Environment]::NewLine + "host=127.0.0.1" + [Environment]::NewLine + "port=$DbPort" + [Environment]::NewLine + "protocol=TCP")
    $serverArgs = $common + @("--port=$DbPort", '--bind-address=127.0.0.1', '--mysqlx=OFF', '--local-infile=OFF')
    $marker = Join-Path $state 'provisioned'
    if (-not (Test-Path -LiteralPath $marker)) {
        $initSql = Join-Path $state 'bootstrap-private.tmp'
        $sql = @"
ALTER USER 'root'@'localhost' IDENTIFIED BY '$($creds.root)';
CREATE DATABASE IF NOT EXISTS tcw CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'tcw_app'@'127.0.0.1' IDENTIFIED BY '$($creds.app)';
ALTER USER 'tcw_app'@'127.0.0.1' IDENTIFIED BY '$($creds.app)';
GRANT ALL PRIVILEGES ON tcw.* TO 'tcw_app'@'127.0.0.1';
"@
        Write-Utf8 $initSql $sql
        $serverArgs += ('--init-file="{0}"' -f $initSql)
    }
    $database = Start-Process -FilePath $mysqlDaemon -ArgumentList $serverArgs -WindowStyle Hidden -PassThru
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($database.HasExited) { break }
        # mysqladmin ping reports a live server even on authentication failure.
        $probe = Start-Process -FilePath $mysqlExe -ArgumentList @(
            ('--defaults-file="{0}"' -f $rootIni), '--connect-timeout=1', '--database=tcw', '--execute="SELECT 1"'
        ) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $state 'mysql-probe.out') -RedirectStandardError (Join-Path $state 'mysql-probe.err')
        if ($probe.ExitCode -eq 0) { $ok = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ok) { throw "MySQL 未能启动或初始化失败，请查看 $log" }
    if ($initSql) { Write-Utf8 $marker 'ok'; Remove-Item -LiteralPath $initSql -Force; $initSql=$null }
    $settings = @{
        TCW_BIND_ADDRESS='127.0.0.1'
        TCW_PORT="$ApiPort"
        TCW_DB_URL="jdbc:mysql://127.0.0.1:$DbPort/tcw?sslMode=DISABLED&allowPublicKeyRetrieval=true&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true"
        TCW_DB_USER='tcw_app'
        TCW_DB_PASSWORD=$creds.app
    }
    foreach ($key in $settings.Keys) {
        $oldEnv[$key]=[Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key,$settings[$key],'Process')
    }
    $java=Start-Process -FilePath $JavaExe -ArgumentList @('-jar', ('"{0}"' -f $JarPath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $state 'server.log') -RedirectStandardError (Join-Path $state 'server-errors.log')
    foreach ($key in $oldEnv.Keys) { [Environment]::SetEnvironmentVariable($key,$oldEnv[$key],'Process') }
    $oldEnv = @{}
    Write-Host "协作服务正在启动：http://127.0.0.1:$ApiPort"
    Write-Host "启动日志：$state\server.log；保持此终端打开，按 Ctrl+C 停止。"
    while (-not $java.HasExited -and -not (Test-Path -LiteralPath $stopFile)) { Start-Sleep -Milliseconds 600 }
    if ($java.HasExited -and $java.ExitCode -ne 0) { throw "协作服务退出（$($java.ExitCode)），请查看 $state\server.log" }
} finally {
    foreach ($key in $oldEnv.Keys) { [Environment]::SetEnvironmentVariable($key,$oldEnv[$key],'Process') }
    if ($java -and -not $java.HasExited) { Stop-Process -InputObject $java -ErrorAction SilentlyContinue }
    if ($database -and -not $database.HasExited) {
        if ($rootIni -and (Test-Path -LiteralPath $rootIni)) {
            $shutdown = Start-Process -FilePath $mysqlAdmin -ArgumentList @(
                ('--defaults-file="{0}"' -f $rootIni), '--connect-timeout=3', 'shutdown'
            ) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $state 'shutdown.out') -RedirectStandardError (Join-Path $state 'shutdown.err')
            if ($shutdown.ExitCode -ne 0) { Write-Warning 'MySQL 未正常关闭，请查看 shutdown.err。' }
        }
    }
    if ($rootIni -and (Test-Path -LiteralPath $rootIni)) { Remove-Item -LiteralPath $rootIni -Force }
    if ($initSql -and (Test-Path -LiteralPath $initSql)) { Remove-Item -LiteralPath $initSql -Force }
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
    $lock.Dispose()
}
