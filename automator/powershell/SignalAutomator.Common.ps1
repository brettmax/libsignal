<#
.SYNOPSIS
Shared helpers for the Windows scripts of Signal Automator.

.DESCRIPTION
Dot-sourced by Install-SignalAutomator.ps1, Link-SignalDevice.ps1,
Start-SignalAutomator.ps1 and Stop-SignalAutomator.ps1. It only defines
functions; running it on its own does nothing.

Files (Windows):
    %APPDATA%\SignalAutomator\config.env        settings, KEY=value per line
                                                (SIGNAL_AUTOMATOR_CONFIG overrides the path)
    %LOCALAPPDATA%\SignalAutomator\signal-cli\  signal-cli, downloaded by Install-SignalAutomator.ps1
    %LOCALAPPDATA%\SignalAutomator\logs\        daemon.log, server.log and their PID files

Settings are read from config.env; environment variables of the same name win.
The file is only read, never executed, and only AUTOMATOR_*, SIGNAL_* and
JAVA_HOME are accepted: the same format as bin/_common.sh uses on macOS/Linux.

.NOTES
Works with Windows PowerShell 5.1 and PowerShell 7.
#>

$script:SASettingPattern = '^(AUTOMATOR_[A-Za-z0-9_]*|SIGNAL_[A-Za-z0-9_]*|JAVA_HOME)$'

function Test-SAWindows {
    # Windows PowerShell 5.1 has no $IsWindows, so ask .NET.
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Assert-SAWindows {
    # Stops with a pointer to the bash scripts when run on macOS or Linux.
    param([string]$Alternative)
    if (-not (Test-SAWindows)) {
        throw "This script is for Windows. On macOS and Linux use $Alternative instead."
    }
}

function Write-SAStep {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-SAOk {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Get-SAPath {
    # Where Signal Automator keeps its files on this computer.
    $automatorDir = Split-Path -Parent $PSScriptRoot
    $configFile = $env:SIGNAL_AUTOMATOR_CONFIG
    if (-not $configFile) {
        $configFile = Join-Path -Path (Join-Path -Path $env:APPDATA -ChildPath 'SignalAutomator') -ChildPath 'config.env'
    }
    $dataHome = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'SignalAutomator'
    $logDir = Join-Path -Path $dataHome -ChildPath 'logs'
    return [pscustomobject]@{
        AutomatorDir  = $automatorDir
        ConfigFile    = $configFile
        SignalCliHome = Join-Path -Path $dataHome -ChildPath 'signal-cli'
        LogDir        = $logDir
        DaemonLog     = Join-Path -Path $logDir -ChildPath 'daemon.log'
        ServerLog     = Join-Path -Path $logDir -ChildPath 'server.log'
    }
}

function Read-SAConfig {
    # Reads config.env into a hashtable: # comments, optional "export ", one pair of
    # surrounding quotes removed, nothing evaluated. Unknown names are skipped with a warning.
    param([string]$Path = (Get-SAPath).ConfigFile)
    $settings = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $settings
    }
    foreach ($rawLine in [System.IO.File]::ReadAllLines($Path)) {
        $line = $rawLine.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) {
            continue
        }
        if ($line.StartsWith('export ')) {
            $line = $line.Substring(7).TrimStart()
        }
        $equals = $line.IndexOf('=')
        if ($equals -lt 1) {
            Write-Warning "${Path}: ignoring a line that is not KEY=value: $rawLine"
            continue
        }
        $key = $line.Substring(0, $equals).Trim()
        $value = $line.Substring($equals + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($key -cnotmatch $script:SASettingPattern) {
            Write-Warning "${Path}: ignoring unknown setting: $key"
            continue
        }
        $settings[$key] = $value
    }
    return $settings
}

function ConvertTo-SAConfigValue {
    # Plain values are written as they are, others in single quotes (read back without them).
    param([string]$Value)
    if ($Value -cmatch "^[A-Za-z0-9_./:@+,=\\-]*$" -or $Value.Contains("'")) {
        return $Value
    }
    return "'$Value'"
}

function Set-SAConfigValue {
    # Stores NAME=VALUE in config.env, replacing an earlier value (UTF-8 without BOM).
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )
    $path = (Get-SAPath).ConfigFile
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        $null = New-Item -ItemType Directory -Path $dir -Force
    }
    $lines = New-Object -TypeName 'System.Collections.Generic.List[string]'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $pattern = '^\s*(export\s+)?' + [regex]::Escape($Name) + '\s*='
        foreach ($line in [System.IO.File]::ReadAllLines($path)) {
            if ($line -cnotmatch $pattern) {
                $lines.Add($line)
            }
        }
    } else {
        $lines.Add('# Signal Automator settings for the scripts in powershell\ (KEY=value, one per line).')
        $lines.Add('# Environment variables with the same names take precedence.')
    }
    $lines.Add("$Name=$(ConvertTo-SAConfigValue -Value $Value)")
    $text = ($lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($path, $text, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false))
}

function Get-SASetting {
    # The effective settings: config.env, overridden by environment variables.
    $settings = Read-SAConfig
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $name = [string]$entry.Key
        if ($name -cmatch $script:SASettingPattern) {
            $settings[$name] = [string]$entry.Value
        }
    }
    return $settings
}

function Split-SAWord {
    # Splits a settings string such as SIGNAL_CLI_ARGS at whitespace.
    param([string]$Text)
    if (-not $Text) {
        return @()
    }
    return @($Text.Split([char[]]@(' ', "`t"), [System.StringSplitOptions]::RemoveEmptyEntries))
}

function Invoke-SANativeCommand {
    # Runs a program and returns its exit code and output (stderr included) without
    # Windows PowerShell 5.1 turning stderr lines into errors under ErrorActionPreference=Stop.
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
}

function Invoke-SANativeCommandLive {
    # Runs a program with its output shown in the console and returns its exit code
    # (stderr lines are not turned into errors, not even in the ISE).
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList | Out-Host
    return $LASTEXITCODE
}

function Get-SANodeMajorVersion {
    # The major version of node on the PATH, or $null.
    $node = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        return $null
    }
    $result = Invoke-SANativeCommand -FilePath $node.Source -ArgumentList @('-p', 'process.versions.node')
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        return $null
    }
    $version = [string]$result.Output[0]
    if ($version -match '^(\d+)\.') {
        return [int]$Matches[1]
    }
    return $null
}

function Assert-SANode {
    # Stops unless Node.js 20 or newer is installed.
    $major = Get-SANodeMajorVersion
    $hint = 'Install the LTS release with: winget install OpenJS.NodeJS.LTS (or from https://nodejs.org), then open a new PowerShell window.'
    if ($null -eq $major) {
        throw "Node.js 20 or newer is required, but node was not found. $hint"
    }
    if ($major -lt 20) {
        throw "Node.js 20 or newer is required (found version $major). $hint"
    }
}

function Get-SAJavaCommand {
    # java.exe from JAVA_HOME, else from the PATH, else $null.
    param([hashtable]$Settings)
    $javaHome = $Settings['JAVA_HOME']
    if ($javaHome) {
        foreach ($name in @('java.exe', 'java')) {
            $candidate = Join-Path -Path (Join-Path -Path $javaHome -ChildPath 'bin') -ChildPath $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }
    $java = Get-Command -Name 'java' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($java) {
        return $java.Source
    }
    return $null
}

function Get-SAJavaMajorVersion {
    # The major Java version (8, 17, 21, ...) or $null when Java is not installed.
    param([hashtable]$Settings)
    $java = Get-SAJavaCommand -Settings $Settings
    if (-not $java) {
        return $null
    }
    $result = Invoke-SANativeCommand -FilePath $java -ArgumentList @('-version')
    foreach ($line in $result.Output) {
        if ($line -match 'version "([^"]+)"') {
            $version = $Matches[1]
            if ($version.StartsWith('1.')) {
                $version = $version.Substring(2)
            }
            if ($version -match '^(\d+)') {
                return [int]$Matches[1]
            }
        }
    }
    return $null
}

function Get-SAJavaHint {
    return 'Install Java 21 or newer with: winget install EclipseAdoptium.Temurin.21.JRE (or from https://adoptium.net), then open a new PowerShell window.'
}

function Find-SASignalCli {
    # signal-cli to use: SIGNAL_CLI (saved by Install-SignalAutomator.ps1), then the PATH,
    # then the newest copy under %LOCALAPPDATA%\SignalAutomator\signal-cli. $null if none.
    param([hashtable]$Settings)
    $configured = $Settings['SIGNAL_CLI']
    if ($configured) {
        if (Test-Path -LiteralPath $configured -PathType Leaf) {
            return (Resolve-Path -LiteralPath $configured).ProviderPath
        }
        $command = Get-Command -Name $configured -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            return $command.Source
        }
        Write-Warning "SIGNAL_CLI=$configured was not found; looking for signal-cli elsewhere."
    }
    $command = Get-Command -Name 'signal-cli' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        return $command.Source
    }
    $installRoot = (Get-SAPath).SignalCliHome
    if (Test-Path -LiteralPath $installRoot) {
        $found = Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter 'signal-cli.bat' -ErrorAction SilentlyContinue |
            Sort-Object -Property LastWriteTime -Descending |
            Select-Object -First 1
        if ($found) {
            return $found.FullName
        }
    }
    return $null
}

function Test-SAHttp {
    # True if anything answers HTTP at the URI, whatever the status code.
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSec = 3
    )
    try {
        $null = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
        return $true
    } catch {
        $exceptionResponse = $null
        if ($_.Exception.PSObject.Properties['Response']) {
            $exceptionResponse = $_.Exception.Response
        }
        return ($null -ne $exceptionResponse)
    }
}

function Get-SAServerKind {
    # 'signal-cli' or 'mock' when a Signal Automator answers at the URL, else $null.
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $status = Invoke-RestMethod -Uri "$Url/api/status" -UseBasicParsing -TimeoutSec 3
        if ($status -and $status.PSObject.Properties['kind']) {
            return [string]$status.kind
        }
    } catch {
        Write-Verbose "no automator status at ${Url}: $_"
    }
    return $null
}

function Get-SAUiUrl {
    # The address to open in a browser for the configured AUTOMATOR_HOST and AUTOMATOR_PORT.
    param([hashtable]$Settings)
    $hostName = $Settings['AUTOMATOR_HOST']
    if (-not $hostName -or $hostName -eq '0.0.0.0' -or $hostName -eq '::') {
        $hostName = '127.0.0.1'
    }
    if ($hostName.Contains(':')) {
        $hostName = "[$hostName]"
    }
    $port = $Settings['AUTOMATOR_PORT']
    if (-not $port) {
        $port = '7583'
    }
    return "http://${hostName}:$port"
}

function ConvertTo-SACmdArgument {
    # Quotes one argument for a cmd.exe command line.
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    if ($Value.Contains('"')) {
        throw "Arguments cannot contain double quotes: $Value"
    }
    # A backslash before the closing quote would escape it, so double trailing backslashes.
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}

function Start-SABackgroundProcess {
    # Starts a program in a hidden window through cmd.exe, which appends its output to
    # logs\<Name>.log (the previous log is kept as <Name>.log.1), and records the PID of
    # that cmd.exe in logs\<Name>.pid. Returns the process.
    #
    # Start-Process without redirection uses ShellExecute, so the program inherits no
    # handles from this PowerShell (a caller capturing our output does not wait for it)
    # and has its own console (closing this window does not stop it). ShellExecute
    # passes this process's environment on, so $Environment is set here just for the start.
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory
    )
    $paths = Get-SAPath
    if (-not (Test-Path -LiteralPath $paths.LogDir)) {
        $null = New-Item -ItemType Directory -Path $paths.LogDir -Force
    }
    $log = Join-Path -Path $paths.LogDir -ChildPath "$Name.log"
    if (Test-Path -LiteralPath $log) {
        try {
            Move-Item -LiteralPath $log -Destination "$log.1" -Force
        } catch {
            Write-Verbose "could not rotate ${log}: $_"
        }
    }
    $command = (@($FilePath) + $ArgumentList | ForEach-Object { ConvertTo-SACmdArgument -Value $_ }) -join ' '
    # /s: cmd.exe removes the outer quotes and runs the rest as it is.
    $startParameters = @{
        FilePath     = $env:ComSpec
        ArgumentList = '/d /s /c "' + $command + ' >> ' + (ConvertTo-SACmdArgument -Value $log) + ' 2>&1"'
        PassThru     = $true
    }
    if ($WorkingDirectory) {
        $startParameters.WorkingDirectory = $WorkingDirectory
    }
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $startParameters.WindowStyle = 'Hidden'
    }
    $saved = @{}
    foreach ($key in $Environment.Keys) {
        $saved[$key] = [System.Environment]::GetEnvironmentVariable($key, 'Process')
        $value = [string]$Environment[$key]
        if ($value -eq '') {
            $value = $null
        }
        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
    try {
        $process = Start-Process @startParameters
    } finally {
        foreach ($key in $saved.Keys) {
            [System.Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
        }
    }
    Set-Content -LiteralPath (Join-Path -Path $paths.LogDir -ChildPath "$Name.pid") -Value $process.Id -Encoding Ascii
    return $process
}

function Get-SARunningProcess {
    # The cmd.exe started for $Name ('daemon' or 'server') if it still runs, else $null.
    param([Parameter(Mandatory = $true)][string]$Name)
    $paths = Get-SAPath
    $pidFile = Join-Path -Path $paths.LogDir -ChildPath "$Name.pid"
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return $null
    }
    [int]$processId = 0
    if (-not [int]::TryParse([string](Get-Content -LiteralPath $pidFile -TotalCount 1), [ref]$processId)) {
        return $null
    }
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
        return $null
    }
    # Guard against a reused PID: the command line of our cmd.exe names the log file.
    $log = Join-Path -Path $paths.LogDir -ChildPath "$Name.log"
    try {
        $info = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
        if ($info -and $info.CommandLine -and -not $info.CommandLine.Contains($log)) {
            return $null
        }
    } catch {
        Write-Verbose "could not read the command line of process ${processId}: $_"
    }
    return $process
}

function Remove-SAPidFile {
    param([Parameter(Mandatory = $true)][string]$Name)
    $pidFile = Join-Path -Path (Get-SAPath).LogDir -ChildPath "$Name.pid"
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-SAProcessTree {
    # Ends a process and everything it started (cmd.exe -> java.exe or node.exe).
    param([Parameter(Mandatory = $true)][int]$Id)
    $result = Invoke-SANativeCommand -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$Id", '/T', '/F')
    if ($result.ExitCode -ne 0) {
        Write-Verbose ($result.Output -join [System.Environment]::NewLine)
    }
    Wait-Process -Id $Id -Timeout 15 -ErrorAction SilentlyContinue
}

function Show-SALogTail {
    # Prints the last lines of a log file.
    param([string]$Path, [int]$Lines = 25)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    Write-Host "--- last lines of $Path ---" -ForegroundColor DarkGray
    foreach ($line in @(Get-Content -LiteralPath $Path -Tail $Lines)) {
        Write-Host "  $line"
    }
}
