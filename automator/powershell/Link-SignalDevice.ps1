<#
.SYNOPSIS
Links this computer to your Signal account as an extra device, like Signal Desktop.

.DESCRIPTION
Runs "signal-cli link", shows the link as a QR code in this window and waits
while you scan it on your phone: Signal > Settings > Linked devices > Link new
device. When the phone confirms, the account's number is saved as
SIGNAL_ACCOUNT in %APPDATA%\SignalAutomator\config.env, where
Start-SignalAutomator.ps1 picks it up.

The QR code is drawn with qrencode when it is installed, otherwise with Node.js
(bin\qr.mjs, which works offline). The same code is also written to a local web
page (-Browser opens it for you), and the link itself is printed so that you can
paste it into a QR code generator you trust instead.

Like Signal Desktop, the linked device can read and send your messages from now
on. You can unlink it at any time in Signal's Linked devices screen.

.PARAMETER Name
The name shown in Signal's list of linked devices. Default: Signal Automator.

.PARAMETER Browser
Also open the QR code in your web browser.

.PARAMETER Force
Link again although an account is already configured.

.EXAMPLE
.\powershell\Link-SignalDevice.ps1

.EXAMPLE
.\powershell\Link-SignalDevice.ps1 -Name 'Office PC' -Browser

.NOTES
Run Install-SignalAutomator.ps1 first. The code is only valid for a few minutes;
if it expires, run this script again.
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Name = 'Signal Automator',

    [switch]$Browser,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.Common.ps1')
Assert-SAWindows -Alternative 'bin/link-device.sh'

$paths = Get-SAPath
$settings = Get-SASetting

if ($settings['SIGNAL_ACCOUNT'] -and -not $Force) {
    Write-Host "Already linked: SIGNAL_ACCOUNT=$($settings['SIGNAL_ACCOUNT']) (from $($paths.ConfigFile) or the environment)."
    Write-Host 'Start the automator with .\powershell\Start-SignalAutomator.ps1, or run this again with -Force to link anew.'
    return
}

$daemon = Get-SARunningProcess -Name 'daemon'
if ($daemon) {
    throw "The signal-cli daemon is running (PID $($daemon.Id)). Stop it with .\powershell\Stop-SignalAutomator.ps1 first, then run this again."
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

$node = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$qrencode = Get-Command -Name 'qrencode' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$qrScript = Join-Path -Path (Join-Path -Path $paths.AutomatorDir -ChildPath 'bin') -ChildPath 'qr.mjs'

$tempDir = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('signal-automator-link-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $tempDir -Force
$outFile = Join-Path -Path $tempDir -ChildPath 'link.out'
$page = Join-Path -Path $tempDir -ChildPath 'link-qr.html'

$arguments = @(Split-SAWord -Text $settings['SIGNAL_CLI_ARGS']) + @('link', '-n', $Name)
$command = (@($signalCli) + $arguments | ForEach-Object { ConvertTo-SACmdArgument -Value $_ }) -join ' '
# cmd.exe runs signal-cli.bat and writes its standard output to a file, which is read below
# while signal-cli waits for the phone. Error messages still appear in this window.
$cmdArguments = '/d /s /c "' + $command + ' > ' + (ConvertTo-SACmdArgument -Value $outFile) + '"'

$savedJavaHome = $env:JAVA_HOME
$process = $null
$account = $null
try {
    if ($settings['JAVA_HOME']) {
        $env:JAVA_HOME = $settings['JAVA_HOME']
    }
    Write-SAStep "Starting signal-cli link -n `"$Name`""
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArguments -NoNewWindow -PassThru
    $null = $process.Handle # keeps the exit code readable after the process ends

    $position = 0
    $pending = ''
    while ($true) {
        $finished = $process.HasExited
        $lines = @()
        if (Test-Path -LiteralPath $outFile -PathType Leaf) {
            $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
            $stream = New-Object -TypeName System.IO.FileStream -ArgumentList $outFile, ([System.IO.FileMode]::Open), ([System.IO.FileAccess]::Read), $share
            try {
                $null = $stream.Seek($position, [System.IO.SeekOrigin]::Begin)
                $reader = New-Object -TypeName System.IO.StreamReader -ArgumentList $stream
                $pending += $reader.ReadToEnd()
                $position = $stream.Position
            } finally {
                $stream.Dispose()
            }
            $parts = $pending -split "`n"
            $pending = $parts[-1]
            if ($parts.Count -gt 1) {
                $lines = $parts[0..($parts.Count - 2)]
            }
            if ($finished -and $pending) {
                $lines += $pending
                $pending = ''
            }
        }
        foreach ($rawLine in $lines) {
            $line = $rawLine.TrimEnd("`r")
            if ($line -match '^(sgnl://|tsdevice:)') {
                Write-Host ''
                Write-Host 'On your phone, open Signal > Settings > Linked devices > Link new device, and scan this code:' -ForegroundColor White
                Write-Host ''
                # Started directly on this console so the block characters and colors come out right.
                $drawn = $false
                if ($qrencode) {
                    $qr = Start-Process -FilePath $qrencode.Source -ArgumentList @('-t', 'ansiutf8', "`"$line`"") -NoNewWindow -Wait -PassThru
                    $drawn = $qr.ExitCode -eq 0
                }
                if (-not $drawn -and $node) {
                    $qr = Start-Process -FilePath $node.Source -ArgumentList @("`"$qrScript`"", "`"$line`"") -NoNewWindow -Wait -PassThru
                    $drawn = $qr.ExitCode -eq 0
                }
                if (-not $drawn) {
                    Write-Host '(No QR code tool was found: install Node.js or qrencode, or use the link below.)'
                }
                Write-Host ''
                if ($node) {
                    $html = Invoke-SANativeCommand -FilePath $node.Source -ArgumentList @($qrScript, '--html', $page, $line)
                    if ($html.ExitCode -eq 0) {
                        Write-Host 'If the code does not scan (small window, unusual font), open this page and scan it there:'
                        Write-Host "  $page"
                        if ($Browser) {
                            Start-Process -FilePath $page
                        }
                    }
                }
                Write-Host 'Or paste this link into a QR code generator you trust (it is only valid for a few minutes):'
                Write-Host "  $line"
                Write-Host ''
                Write-Host 'Waiting for your phone... (Ctrl+C to cancel)' -ForegroundColor DarkGray
            } elseif ($line -match '^Associated with: (.+)$') {
                $account = $Matches[1].Trim()
            } elseif ($line) {
                Write-Host $line
            }
        }
        if ($finished) {
            break
        }
        Start-Sleep -Milliseconds 300
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
} finally {
    $env:JAVA_HOME = $savedJavaHome
    if ($process -and -not $process.HasExited) {
        Stop-SAProcessTree -Id $process.Id
    }
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0 -or -not $account) {
    if ($exitCode -eq 0) {
        throw 'signal-cli finished without reporting the linked account. Try again.'
    }
    throw "Linking did not complete (signal-cli exited with code $exitCode). See the messages above; if the code expired, run this again."
}

Set-SAConfigValue -Name 'SIGNAL_ACCOUNT' -Value $account
Write-Host ''
Write-SAOk "Linked. This computer is now a linked device of $account."
Write-Host "Saved SIGNAL_ACCOUNT=$account in $($paths.ConfigFile)."
Write-Host 'Next: .\powershell\Start-SignalAutomator.ps1   (on the first start signal-cli may need a minute to sync contacts and groups)'
