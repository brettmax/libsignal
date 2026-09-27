<#
.SYNOPSIS
Stops Signal Automator: the automator server and the signal-cli daemon started by Start-SignalAutomator.ps1.

.DESCRIPTION
Ends the processes recorded in %LOCALAPPDATA%\SignalAutomator\logs\server.pid
and daemon.pid, including the node.exe and java.exe they started. Windows has
no gentle way to stop a program that has no window, so they are ended at once;
the automator saves every change within a quarter of a second, so nothing is
lost unless you stop it in the same moment you change something.

.PARAMETER ServerOnly
Keep the signal-cli daemon running (the next start is faster).

.EXAMPLE
.\powershell\Stop-SignalAutomator.ps1

.EXAMPLE
.\powershell\Stop-SignalAutomator.ps1 -ServerOnly
#>
[CmdletBinding()]
param(
    [switch]$ServerOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.Common.ps1')
Assert-SAWindows -Alternative 'bin/stop.sh'

$settings = Get-SASetting
$stopped = $false

$server = Get-SARunningProcess -Name 'server'
if ($server) {
    Write-SAStep "Stopping the automator server (PID $($server.Id))"
    Stop-SAProcessTree -Id $server.Id
    $stopped = $true
}
Remove-SAPidFile -Name 'server'

if (-not $ServerOnly) {
    $daemon = Get-SARunningProcess -Name 'daemon'
    if ($daemon) {
        Write-SAStep "Stopping the signal-cli daemon (PID $($daemon.Id))"
        Stop-SAProcessTree -Id $daemon.Id
        $stopped = $true
    }
    Remove-SAPidFile -Name 'daemon'
}

if ($stopped) {
    Write-SAOk 'Stopped.'
} else {
    Write-Host 'Nothing to stop: no server or daemon started by Start-SignalAutomator.ps1 is running.'
}

$url = Get-SAUiUrl -Settings $settings
if (Test-SAHttp -Uri "$url/api/status") {
    Write-Warning "An automator server still answers at $url. Start-SignalAutomator.ps1 did not start it (npm start in another window?), so stop it where it runs, with Ctrl+C."
}
if (-not $ServerOnly) {
    $daemonUrl = $settings['SIGNAL_CLI_URL']
    if (-not $daemonUrl) {
        $daemonUrl = 'http://127.0.0.1:7584'
    }
    if (Test-SAHttp -Uri "$($daemonUrl.TrimEnd('/'))/api/v1/check") {
        Write-Host "Note: a signal-cli daemon that Start-SignalAutomator.ps1 did not start is still running at $daemonUrl."
    }
}
