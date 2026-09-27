<#
.SYNOPSIS
Installs what Signal Automator needs on Windows and builds it.

.DESCRIPTION
1. Checks for Node.js 20 or newer (and npm).
2. Checks for Java 21 or newer, which signal-cli needs.
3. If signal-cli is not found, downloads the latest release from
   https://github.com/AsamK/signal-cli (the Java build, which contains
   bin\signal-cli.bat) into %LOCALAPPDATA%\SignalAutomator\signal-cli, verifies
   its checksum and saves its path as SIGNAL_CLI in
   %APPDATA%\SignalAutomator\config.env.
4. Runs npm install and npm run build in the automator folder.

Safe to run again, for example after pulling new code. Missing Node.js or Java
can be installed with winget (the script prints the exact commands).

.PARAMETER SkipSignalCli
Do not check or install signal-cli or Java (enough for Start-SignalAutomator.ps1 -Mock).

.PARAMETER ForceSignalCli
Download the latest signal-cli even if one is already installed.

.PARAMETER NoBuild
Skip npm install and npm run build.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\powershell\Install-SignalAutomator.ps1

.EXAMPLE
.\powershell\Install-SignalAutomator.ps1 -ForceSignalCli

.NOTES
Next steps: Link-SignalDevice.ps1, then Start-SignalAutomator.ps1
(or Start-SignalAutomator.ps1 -Mock to try it without a phone).
SIGNAL_CLI_RELEASES_API can point at a mirror of the GitHub releases API.
#>
[CmdletBinding()]
param(
    [switch]$SkipSignalCli,
    [switch]$ForceSignalCli,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.Common.ps1')
Assert-SAWindows -Alternative 'bin/install.sh'

$paths = Get-SAPath
$settings = Get-SASetting

function Install-SASignalCli {
    # Downloads the latest Java build of signal-cli and returns the path of signal-cli.bat.
    $api = $settings['SIGNAL_CLI_RELEASES_API']
    if (-not $api) {
        $api = 'https://api.github.com/repos/AsamK/signal-cli/releases/latest'
    }
    # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

    Write-SAStep 'Looking up the latest signal-cli release'
    try {
        $release = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers @{ 'User-Agent' = 'signal-automator-installer' }
    } catch {
        throw "Could not reach $api ($($_.Exception.Message)). Install signal-cli yourself and set SIGNAL_CLI in $($paths.ConfigFile)."
    }
    $asset = @($release.assets | Where-Object {
            $_.name -match '^signal-cli-v?\d[\w.+-]*\.tar\.gz$' -and $_.name -notmatch '(?i)native|client|linux|macos|windows'
        }) | Select-Object -First 1
    if (-not $asset) {
        throw "No Java build of signal-cli among the files of release $($release.tag_name): $(($release.assets | ForEach-Object { $_.name }) -join ', ')"
    }
    $version = ([string]$release.tag_name).TrimStart('v')
    $dest = Join-Path -Path $paths.SignalCliHome -ChildPath $version
    $tempDir = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('signal-automator-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $tempDir -Force
    try {
        $archive = Join-Path -Path $tempDir -ChildPath $asset.name
        Write-SAStep "Downloading $($asset.name)"
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue' # the progress bar makes Windows PowerShell 5.1 downloads very slow
        try {
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -UseBasicParsing
        } finally {
            $ProgressPreference = $previousProgress
        }
        $digest = ''
        if ($asset.PSObject.Properties['digest'] -and $asset.digest) {
            $digest = [string]$asset.digest
        }
        if ($digest.StartsWith('sha256:')) {
            $expected = $digest.Substring(7)
            $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $expected.ToLowerInvariant()) {
                throw "Checksum mismatch for $($asset.name): expected $expected, got $actual."
            }
            Write-Host "Checksum OK (sha256 $actual)"
        } else {
            Write-Warning "GitHub published no checksum for $($asset.name); skipping verification."
        }

        if (Test-Path -LiteralPath $dest) {
            Remove-Item -LiteralPath $dest -Recurse -Force
        }
        $null = New-Item -ItemType Directory -Path $dest -Force
        $tar = Get-Command -Name 'tar.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $tar) {
            throw "tar.exe was not found (it comes with Windows 10 1803 and later). Unpack $archive into $dest yourself and set SIGNAL_CLI to its bin\signal-cli.bat."
        }
        $result = Invoke-SANativeCommand -FilePath $tar.Source -ArgumentList @('-xzf', $archive, '-C', $dest)
        if ($result.ExitCode -ne 0) {
            throw "Could not unpack $($asset.name): $($result.Output -join ' ')"
        }
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $bat = Get-ChildItem -LiteralPath $dest -Recurse -File -Filter 'signal-cli.bat' | Select-Object -First 1
    if (-not $bat) {
        throw "Unpacked $($asset.name), but it contains no signal-cli.bat."
    }
    return $bat.FullName
}

Write-SAStep 'Checking Node.js'
Assert-SANode
$npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npm) {
    throw 'npm was not found next to Node.js. Reinstall Node.js with: winget install OpenJS.NodeJS.LTS'
}
$nodeVersion = (Invoke-SANativeCommand -FilePath 'node.exe' -ArgumentList @('--version')).Output -join ''
$npmVersion = (Invoke-SANativeCommand -FilePath $npm.Source -ArgumentList @('--version')).Output -join ''
Write-Host "Node.js $nodeVersion, npm $npmVersion"

if ($SkipSignalCli) {
    Write-Host 'Skipping signal-cli (-SkipSignalCli): only Start-SignalAutomator.ps1 -Mock will work.'
} else {
    Write-SAStep 'Checking Java'
    $javaMajor = Get-SAJavaMajorVersion -Settings $settings
    if ($null -eq $javaMajor) {
        throw "signal-cli needs Java 21 or newer, and Java was not found. $(Get-SAJavaHint)"
    }
    if ($javaMajor -lt 21) {
        throw "signal-cli needs Java 21 or newer (found Java $javaMajor). $(Get-SAJavaHint)"
    }
    Write-Host "Java $javaMajor"

    Write-SAStep 'Checking signal-cli'
    $existing = $null
    if (-not $ForceSignalCli) {
        $existing = Find-SASignalCli -Settings $settings
    }
    if ($existing) {
        Write-Host "Found signal-cli: $existing"
        $check = Invoke-SANativeCommand -FilePath $existing -ArgumentList @('--version')
        if ($check.ExitCode -eq 0) {
            Write-Host ($check.Output -join [System.Environment]::NewLine)
            if ($settings['SIGNAL_CLI'] -ne $existing) {
                Set-SAConfigValue -Name 'SIGNAL_CLI' -Value $existing
            }
        } else {
            Write-Warning "'$existing --version' failed: $($check.Output -join ' ')"
            Write-Warning 'Run this script with -ForceSignalCli to download a fresh copy.'
        }
    } else {
        $installed = Install-SASignalCli
        Set-SAConfigValue -Name 'SIGNAL_CLI' -Value $installed
        Write-SAOk "Installed signal-cli: $installed"
    }
}

if (-not $NoBuild) {
    Push-Location -LiteralPath $paths.AutomatorDir
    try {
        Write-SAStep "Installing npm packages (npm install in $($paths.AutomatorDir))"
        $code = Invoke-SANativeCommandLive -FilePath $npm.Source -ArgumentList @('install')
        if ($code -ne 0) {
            throw "npm install failed (exit code $code)."
        }
        Write-SAStep 'Building the server and the web UI (npm run build)'
        $code = Invoke-SANativeCommandLive -FilePath $npm.Source -ArgumentList @('run', 'build')
        if ($code -ne 0) {
            throw "npm run build failed (exit code $code)."
        }
    } finally {
        Pop-Location
    }
}

Write-Host ''
Write-SAOk 'Done.'
if ($SkipSignalCli) {
    Write-Host 'Next: .\powershell\Start-SignalAutomator.ps1 -Mock   (try the app without a phone; nothing is really sent)'
} elseif ($settings['SIGNAL_ACCOUNT']) {
    Write-Host "Linked account: $($settings['SIGNAL_ACCOUNT']). Next: .\powershell\Start-SignalAutomator.ps1"
} else {
    Write-Host 'Next steps:'
    Write-Host '  .\powershell\Link-SignalDevice.ps1          link this computer to your Signal account (scan a QR code)'
    Write-Host '  .\powershell\Start-SignalAutomator.ps1      start signal-cli and the automator, then open http://127.0.0.1:7583'
    Write-Host '  .\powershell\Start-SignalAutomator.ps1 -Mock   or try it first without a phone'
}
