<#
.SYNOPSIS
Starts Signal Automator: the signal-cli daemon, then the automator server, and opens the web UI.

.DESCRIPTION
Starts "signal-cli -a <your number> daemon --http 127.0.0.1:7584" in the
background (unless a daemon already answers there), waits until it is up, then
starts the automator server (node server\dist\index.js) and opens
http://127.0.0.1:7583 in your browser.

Both run without a window and keep running after you close PowerShell. Their
output goes to %LOCALAPPDATA%\SignalAutomator\logs\daemon.log and server.log.
Stop them with Stop-SignalAutomator.ps1.

Settings come from the environment and %APPDATA%\SignalAutomator\config.env:
SIGNAL_ACCOUNT (saved by Link-SignalDevice.ps1), SIGNAL_CLI, SIGNAL_CLI_URL,
SIGNAL_CLI_ARGS, SIGNAL_CLI_DAEMON_ARGS, SIGNAL_CLI_START_TIMEOUT and the
server's AUTOMATOR_* settings. Relative paths are relative to the automator folder.

.PARAMETER Mock
Try the app without Signal: a pretend transport with three fake contacts where
nothing is really sent. Mock mode keeps its own data in automator\data\mock
(AUTOMATOR_MOCK_DATA_DIR changes that).

.PARAMETER Port
Serve the web UI on another port (AUTOMATOR_PORT, default 7583).

.PARAMETER NoBrowser
Do not open the browser.

.EXAMPLE
.\powershell\Start-SignalAutomator.ps1

.EXAMPLE
.\powershell\Start-SignalAutomator.ps1 -Mock

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\powershell\Start-SignalAutomator.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$Mock,

    [ValidateRange(1, 65535)]
    [int]$Port,

    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.Common.ps1')
Assert-SAWindows -Alternative 'bin/start.sh'

$paths = Get-SAPath
$settings = Get-SASetting
if ($Port) {
    $settings['AUTOMATOR_PORT'] = [string]$Port
}
if ($settings['AUTOMATOR_TRANSPORT'] -eq 'mock') {
    $Mock = $true
}

function Resolve-SAAutomatorPath {
    # Relative paths in the settings are relative to the automator folder (the server's working directory).
    param([string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }
    return Join-Path -Path $paths.AutomatorDir -ChildPath $Path
}

function Get-SADaemonHint {
    $log = ''
    if (Test-Path -LiteralPath $paths.DaemonLog -PathType Leaf) {
        $log = Get-Content -LiteralPath $paths.DaemonLog -Raw
    }
    if ($log -match '(?i)not registered') {
        return "signal-cli has no working link for $($settings['SIGNAL_ACCOUNT']) (unlinked on the phone?): run .\powershell\Link-SignalDevice.ps1 -Force."
    }
    if ($log -match '(?i)in use by another instance') {
        return 'Another signal-cli process is using this account; stop it first.'
    }
    if ($log -match 'UnsupportedClassVersionError|compiled by a more recent version') {
        return "signal-cli needs Java 21 or newer. $(Get-SAJavaHint)"
    }
    if ($log -match '(?i)address already in use|BindException') {
        return 'The daemon port is taken; set SIGNAL_CLI_URL to another port, for example http://127.0.0.1:7590.'
    }
    if ($log -match '(?i)UnsatisfiedLinkError|signal_jni|libsignal-client') {
        return "signal-cli could not load libsignal's native library, which its Java build includes only for some platforms and processors. See Troubleshooting in README.md."
    }
    return "See the log above ($($paths.DaemonLog))."
}

function Wait-SAServer {
    # Waits until the server answers; stops with its log when it exits first.
    param([System.Diagnostics.Process]$Process, [string]$Url)
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-SAHttp -Uri "$Url/api/status")) {
        if ($Process.HasExited) {
            Remove-SAPidFile -Name 'server'
            Show-SALogTail -Path $paths.ServerLog
            $log = ''
            if (Test-Path -LiteralPath $paths.ServerLog -PathType Leaf) {
                $log = Get-Content -LiteralPath $paths.ServerLog -Raw
            }
            if ($log -match 'EADDRINUSE') {
                throw "Port $(([uri]$Url).Port) is already in use by another program. Choose another with -Port."
            }
            throw "The automator server stopped during startup; see the log above ($($paths.ServerLog))."
        }
        if ((Get-Date) -gt $deadline) {
            throw "The automator server did not answer at $Url within 60 seconds; see $($paths.ServerLog)."
        }
        Start-Sleep -Seconds 1
    }
}

Assert-SANode
$node = (Get-Command -Name 'node' -CommandType Application | Select-Object -First 1).Source
$serverEntry = Join-Path -Path (Join-Path -Path (Join-Path -Path $paths.AutomatorDir -ChildPath 'server') -ChildPath 'dist') -ChildPath 'index.js'
if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    throw "The server has not been built yet. Run .\powershell\Install-SignalAutomator.ps1 (or npm install and npm run build in $($paths.AutomatorDir))."
}
$webDist = $settings['AUTOMATOR_WEB_DIST']
if (-not $webDist) {
    $webDist = Join-Path -Path (Join-Path -Path $paths.AutomatorDir -ChildPath 'web') -ChildPath 'dist'
}
if (-not (Test-Path -LiteralPath (Join-Path -Path (Resolve-SAAutomatorPath $webDist) -ChildPath 'index.html'))) {
    Write-Warning "The web UI has not been built ($webDist is missing); run npm run build in $($paths.AutomatorDir)."
}

$url = Get-SAUiUrl -Settings $settings
$wantKind = 'signal-cli'
if ($Mock) {
    $wantKind = 'mock'
}

# ---------------------------------------------------------------- already running?

$running = Get-SARunningProcess -Name 'server'
if ($running) {
    Wait-SAServer -Process $running -Url $url
}
if ($running -or (Test-SAHttp -Uri "$url/api/status")) {
    $kind = Get-SAServerKind -Url $url
    if ($kind -eq $wantKind) {
        Write-SAOk "Signal Automator is already running: $url"
        if (-not $NoBrowser) {
            Start-Process -FilePath $url
        }
        return
    }
    if (-not $kind) {
        throw "Something else is already using port $(([uri]$url).Port). Choose another port with -Port (or set AUTOMATOR_PORT)."
    }
    throw "Signal Automator is already running at $url with the $kind transport. Stop it first with .\powershell\Stop-SignalAutomator.ps1."
}

# ---------------------------------------------------------------- signal-cli daemon

$childEnvironment = @{}
foreach ($key in $settings.Keys) {
    $childEnvironment[$key] = $settings[$key]
}

if ($Mock) {
    $mockDir = $settings['AUTOMATOR_MOCK_DATA_DIR']
    if (-not $mockDir) {
        $dataDir = $settings['AUTOMATOR_DATA_DIR']
        if (-not $dataDir) {
            $dataDir = Join-Path -Path $paths.AutomatorDir -ChildPath 'data'
        }
        $mockDir = Join-Path -Path (Resolve-SAAutomatorPath $dataDir) -ChildPath 'mock'
    }
    $mockDir = Resolve-SAAutomatorPath $mockDir
    $null = New-Item -ItemType Directory -Path $mockDir -Force
    $childEnvironment['AUTOMATOR_TRANSPORT'] = 'mock'
    $childEnvironment['AUTOMATOR_DATA_DIR'] = $mockDir
    Write-SAStep "Mock mode: nothing is really sent (data in $mockDir)"
} else {
    $account = $settings['SIGNAL_ACCOUNT']
    if (-not $account) {
        throw 'No Signal account is configured yet. Link this computer first with .\powershell\Link-SignalDevice.ps1 (or try -Mock).'
    }
    $signalCliUrl = $settings['SIGNAL_CLI_URL']
    if (-not $signalCliUrl) {
        $signalCliUrl = 'http://127.0.0.1:7584'
    }
    $signalCliUrl = $signalCliUrl.TrimEnd('/')
    $childEnvironment['AUTOMATOR_TRANSPORT'] = 'signal-cli'
    $childEnvironment['SIGNAL_CLI_URL'] = $signalCliUrl
    $checkUrl = "$signalCliUrl/api/v1/check"

    if (Test-SAHttp -Uri $checkUrl) {
        Write-Host "Using the signal-cli daemon that is already running at $signalCliUrl."
    } else {
        $daemon = Get-SARunningProcess -Name 'daemon'
        if (-not $daemon) {
            $daemonUri = [uri]$signalCliUrl
            if (-not $daemonUri.IsLoopback) {
                throw "Nothing answers at SIGNAL_CLI_URL=$signalCliUrl, and a daemon on another computer cannot be started from here."
            }
            $signalCli = Find-SASignalCli -Settings $settings
            if (-not $signalCli) {
                throw "signal-cli was not found. Run .\powershell\Install-SignalAutomator.ps1 first, or set SIGNAL_CLI in $($paths.ConfigFile)."
            }
            if ($signalCli -match '\.(bat|cmd)$') {
                $javaMajor = Get-SAJavaMajorVersion -Settings $settings
                if ($null -eq $javaMajor -or $javaMajor -lt 21) {
                    throw "signal-cli needs Java 21 or newer (found: $(if ($null -eq $javaMajor) { 'none' } else { "Java $javaMajor" })). $(Get-SAJavaHint)"
                }
            }
            $daemonArgs = '--ignore-attachments --ignore-stories'
            if ($settings.ContainsKey('SIGNAL_CLI_DAEMON_ARGS')) {
                $daemonArgs = $settings['SIGNAL_CLI_DAEMON_ARGS']
            }
            $address = "$($daemonUri.Host):$($daemonUri.Port)"
            $arguments = @(Split-SAWord -Text $settings['SIGNAL_CLI_ARGS']) + @('-a', $account, 'daemon', '--http', $address) + @(Split-SAWord -Text $daemonArgs)
            Write-SAStep "Starting the signal-cli daemon for $account on $address"
            $daemon = Start-SABackgroundProcess -Name 'daemon' -FilePath $signalCli -ArgumentList $arguments -Environment $childEnvironment -WorkingDirectory $paths.AutomatorDir
        }
        $timeout = 120
        if ($settings['SIGNAL_CLI_START_TIMEOUT']) {
            $timeout = [int]$settings['SIGNAL_CLI_START_TIMEOUT']
        }
        $deadline = (Get-Date).AddSeconds($timeout)
        Write-Host 'Waiting for signal-cli to come up (this can take a while on the first start)' -NoNewline
        while (-not (Test-SAHttp -Uri $checkUrl)) {
            if ($daemon.HasExited) {
                Write-Host ''
                Remove-SAPidFile -Name 'daemon'
                Show-SALogTail -Path $paths.DaemonLog
                throw "The signal-cli daemon stopped during startup. $(Get-SADaemonHint)"
            }
            if ((Get-Date) -gt $deadline) {
                Write-Host ''
                Show-SALogTail -Path $paths.DaemonLog
                throw "signal-cli did not answer at $signalCliUrl within $timeout seconds. It is still running (PID $($daemon.Id)): check $($paths.DaemonLog), or stop it with .\powershell\Stop-SignalAutomator.ps1."
            }
            Write-Host '.' -NoNewline
            Start-Sleep -Seconds 1
        }
        Write-Host ''
        Write-SAOk "signal-cli daemon is up at $signalCliUrl"
    }
}

# ---------------------------------------------------------------- server

Write-SAStep "Starting the automator at $url"
$server = Start-SABackgroundProcess -Name 'server' -FilePath $node -ArgumentList @($serverEntry) -Environment $childEnvironment -WorkingDirectory $paths.AutomatorDir
Wait-SAServer -Process $server -Url $url

Write-Host ''
Write-SAOk "Signal Automator is running: $url"
if ($Mock) {
    Write-Host '  mode:  mock (nothing is really sent)'
    Write-Host "  log:   $($paths.ServerLog)"
} else {
    Write-Host "  mode:  signal-cli, account $($settings['SIGNAL_ACCOUNT'])"
    Write-Host "  logs:  $($paths.ServerLog) and $($paths.DaemonLog)"
}
Write-Host '  stop:  .\powershell\Stop-SignalAutomator.ps1'
if ($settings['AUTOMATOR_HOST'] -eq '0.0.0.0' -or $settings['AUTOMATOR_HOST'] -eq '::') {
    Write-Warning "AUTOMATOR_HOST=$($settings['AUTOMATOR_HOST']): anyone on your network can open the UI and send messages as you."
}
if (-not $NoBrowser) {
    Start-Process -FilePath $url
}
