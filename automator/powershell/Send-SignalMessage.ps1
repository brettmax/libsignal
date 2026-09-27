<#
.SYNOPSIS
Sends a Signal message through the running Signal Automator.

.DESCRIPTION
Posts the message to the automator's REST API, which sends it with your linked
Signal account. Outgoing-message scripts run first, exactly as for messages sent
from the web UI (a script may change or cancel it).

The automator must be running (Start-SignalAutomator.ps1, or bin/start.sh on
macOS and Linux). Works with Windows PowerShell 5.1 and PowerShell 7.

.PARAMETER To
Who gets the message: a phone number in international format (+15551234567),
a contact name as shown in the web UI (not case-sensitive), or group:<group name>.

.PARAMETER Message
The text. Several values, or several lines of pipeline input, are sent as
separate messages. Use Get-Content -Raw to send a whole file as one message.

.PARAMETER Group
Treat -To as a group name or group id.

.PARAMETER BaseUrl
The automator's address. Default: $env:AUTOMATOR_URL, else
http://<AUTOMATOR_HOST or 127.0.0.1>:<AUTOMATOR_PORT or 7583>.

.PARAMETER PassThru
Write the sent message objects (id, timestamp, peer, body, ok, ...) to the pipeline.

.EXAMPLE
.\Send-SignalMessage.ps1 -To +15551234567 -Message 'Running 10 minutes late'

.EXAMPLE
.\Send-SignalMessage.ps1 Alice 'The build is green'

.EXAMPLE
.\Send-SignalMessage.ps1 -To 'Family' -Group -Message 'Dinner is ready'

.EXAMPLE
Get-Content .\report.txt -Raw | .\Send-SignalMessage.ps1 -To Alice

.EXAMPLE
.\Send-SignalMessage.ps1 -To Alice -Message 'Test' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$To,

    [Parameter(Mandatory = $true, Position = 1, ValueFromPipeline = $true)]
    [AllowEmptyString()]
    [string[]]$Message,

    [switch]$Group,

    [string]$BaseUrl,

    [switch]$PassThru
)

begin {
    $ErrorActionPreference = 'Stop'
    Import-Module -Name (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.psm1') -Scope Local
    $recipient = Resolve-AutomatorRecipient -To $To -Group:$Group -BaseUrl $BaseUrl
    $label = $To.Trim()
    if ($label -ne $recipient.id) {
        $label = "$label ($($recipient.id))"
    }
    $failed = 0
}

process {
    foreach ($text in $Message) {
        if ([string]::IsNullOrWhiteSpace($text)) {
            Write-Warning 'Skipping an empty message.'
            continue
        }
        if (-not $PSCmdlet.ShouldProcess($label, "Send Signal message '$text'")) {
            continue
        }
        $sent = Invoke-AutomatorApi -Method POST -Path '/api/send' -Body ([ordered]@{ to = $recipient; body = $text }) -BaseUrl $BaseUrl
        if ($sent.PSObject.Properties['ok'] -and $sent.ok -eq $false) {
            $failed++
            Write-Error -Message "Signal did not accept the message to ${label}: $($sent.error)" -ErrorAction Continue
        } else {
            $when = [System.DateTimeOffset]::FromUnixTimeMilliseconds([long]$sent.timestamp).LocalDateTime
            Write-Host ('Sent to {0} at {1:HH:mm:ss}.' -f $label, $when)
        }
        if ($PassThru) {
            $sent
        }
    }
}

end {
    if ($failed -gt 0) {
        exit 1
    }
}
