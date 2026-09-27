<#
.SYNOPSIS
PowerShell client for the Signal Automator REST API.

.DESCRIPTION
Import this module to drive a running Signal Automator from PowerShell
(Windows PowerShell 5.1 or PowerShell 7, on any operating system):

    Import-Module .\powershell\SignalAutomator.psm1
    Get-AutomatorStatus
    Send-AutomatorMessage -To Alice -Message 'On my way'
    New-AutomatorRepeater -To +15551234567 -Message 'Stretch!' -Every 1h
    Get-Command -Module SignalAutomator

The server address is taken from -BaseUrl, else $env:AUTOMATOR_URL, else
http://127.0.0.1:<port> with the port from $env:AUTOMATOR_PORT (default 7583).
Durations such as -Every accept seconds or values like 30s, 10m, 2h, 1d and 1h30m.

.NOTES
The API itself is documented in docs/rest-api.md.
#>

$ErrorActionPreference = 'Stop'

$script:MatchTypes = [ordered]@{
    contains   = 'contains'
    exact      = 'exact'
    startswith = 'startsWith'
    word       = 'word'
    regex      = 'regex'
}

function Get-AutomatorBaseUrl {
    <#
    .SYNOPSIS
    Returns the base URL used when -BaseUrl is not given.

    .DESCRIPTION
    $env:AUTOMATOR_URL when set, else http://<AUTOMATOR_HOST or 127.0.0.1>:<AUTOMATOR_PORT or 7583>.
    A wildcard AUTOMATOR_HOST (0.0.0.0 or ::) is reached through 127.0.0.1.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()
    if ($env:AUTOMATOR_URL) {
        return $env:AUTOMATOR_URL.TrimEnd('/')
    }
    $hostName = $env:AUTOMATOR_HOST
    if (-not $hostName -or $hostName -eq '0.0.0.0' -or $hostName -eq '::') {
        $hostName = '127.0.0.1'
    }
    if ($hostName.Contains(':')) {
        $hostName = "[$hostName]"
    }
    $port = $env:AUTOMATOR_PORT
    if (-not $port) {
        $port = '7583'
    }
    return "http://${hostName}:$port"
}

function ConvertTo-AutomatorError {
    # Turns a failed Invoke-RestMethod call into an ErrorRecord with the HTTP status and the server's message.
    param(
        [System.Management.Automation.ErrorRecord]$ErrorRecord,
        [string]$Method,
        [string]$Uri
    )
    $status = $null
    $exceptionResponse = $null
    if ($ErrorRecord.Exception.PSObject.Properties['Response']) {
        $exceptionResponse = $ErrorRecord.Exception.Response
    }
    if ($null -ne $exceptionResponse) {
        try {
            $status = [int]$exceptionResponse.StatusCode
        } catch {
            $status = $null
        }
    }
    if ($null -eq $status) {
        $message = "Could not reach Signal Automator at $Uri ($($ErrorRecord.Exception.Message)). " +
            'Is it running? Start it with powershell\Start-SignalAutomator.ps1 (Windows) or bin/start.sh.'
    } else {
        $detail = ''
        if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
            $detail = $ErrorRecord.ErrorDetails.Message
            try {
                $parsed = ConvertFrom-Json -InputObject $detail
                if ($parsed.PSObject.Properties['error']) {
                    $detail = [string]$parsed.error
                }
            } catch {
                Write-Verbose 'The error response is not JSON; showing it as it is.'
            }
        }
        $hints = @{
            403 = ' (the server only answers requests addressed to localhost or 127.0.0.1; see AUTOMATOR_HOST)'
            409 = ' (an outgoing-message script cancelled it)'
            503 = ' (the server could not start; check its log)'
        }
        $hint = ''
        if ($hints.ContainsKey($status)) {
            $hint = $hints[$status]
        }
        $message = "Signal Automator API error $status on $Method ${Uri}: $detail$hint"
    }
    $exception = New-Object -TypeName System.Exception -ArgumentList $message, $ErrorRecord.Exception
    $category = [System.Management.Automation.ErrorCategory]::InvalidOperation
    if ($null -eq $status) {
        $category = [System.Management.Automation.ErrorCategory]::ConnectionError
    }
    return New-Object -TypeName System.Management.Automation.ErrorRecord -ArgumentList $exception, "AutomatorApi$status", $category, $Uri
}

function Invoke-AutomatorApi {
    <#
    .SYNOPSIS
    Calls a Signal Automator REST endpoint and returns the parsed JSON response.

    .DESCRIPTION
    Sends -Body as UTF-8 JSON. Errors from the API (HTTP 4xx/5xx with {"error": "..."})
    become terminating errors that include the status code and the server's message.
    JSON arrays are written to the pipeline one element at a time.

    .PARAMETER Method
    GET (default), POST, PUT or DELETE.

    .PARAMETER Path
    The path on the server, for example /api/status or /api/repeaters/<id>/run.

    .PARAMETER Body
    A hashtable or object to send as JSON, or a string that already is JSON.

    .PARAMETER Query
    Query string parameters, for example @{ limit = 20 }.

    .PARAMETER BaseUrl
    The server, for example http://127.0.0.1:7583. See Get-AutomatorBaseUrl for the default.

    .EXAMPLE
    Invoke-AutomatorApi -Path /api/messages -Query @{ limit = 5 }

    .EXAMPLE
    Invoke-AutomatorApi -Method PUT -Path "/api/rules/$id" -Body @{ enabled = $false }
    #>
    [CmdletBinding()]
    param(
        [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
        [string]$Method = 'GET',

        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Path,

        [object]$Body,

        [hashtable]$Query,

        [string]$BaseUrl
    )
    if (-not $BaseUrl) {
        $BaseUrl = Get-AutomatorBaseUrl
    }
    $uri = $BaseUrl.TrimEnd('/') + '/' + $Path.TrimStart('/')
    if ($Query -and $Query.Count -gt 0) {
        $pairs = foreach ($key in $Query.Keys) {
            [uri]::EscapeDataString([string]$key) + '=' + [uri]::EscapeDataString([string]$Query[$key])
        }
        $separator = '?'
        if ($uri.Contains('?')) {
            $separator = '&'
        }
        $uri += $separator + ($pairs -join '&')
    }
    $request = @{
        Uri             = $uri
        Method          = $Method
        UseBasicParsing = $true
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        if ($Body -is [string]) {
            $json = $Body
        } else {
            $json = ConvertTo-Json -InputObject $Body -Depth 10 -Compress
        }
        $request.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $request.ContentType = 'application/json; charset=utf-8'
    }
    Write-Verbose "$Method $uri"
    try {
        $response = Invoke-RestMethod @request
    } catch {
        $PSCmdlet.ThrowTerminatingError((ConvertTo-AutomatorError -ErrorRecord $_ -Method $Method -Uri $uri))
    }
    # 204 No Content (DELETE, simulate) has no body: write nothing rather than $null.
    if ($null -ne $response -and -not ($response -is [string] -and $response -eq '')) {
        Write-Output $response
    }
}

function ConvertTo-AutomatorSeconds {
    <#
    .SYNOPSIS
    Converts a duration such as 90, '30s', '10m', '1.5h', '1h30m', '2d' or a [timespan] to seconds.

    .DESCRIPTION
    A plain number is seconds. Units: s, m, h, d and w (also sec, min, hours, days, ...),
    and they can be combined: 1h30m.

    PowerShell reads an unquoted 1d or 1.5d as a [decimal] number (d is its suffix for
    decimals), so a [decimal] value is taken as days: -Every 1d means one day.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [object]$Duration
    )
    if ($Duration -is [timespan]) {
        $total = [double]$Duration.TotalSeconds
    } elseif ($Duration -is [decimal]) {
        $total = [double]$Duration * 86400
    } elseif ($Duration -is [int] -or $Duration -is [long] -or $Duration -is [double]) {
        $total = [double]$Duration
    } else {
        $text = ([string]$Duration).Trim().ToLowerInvariant() -replace '\s+', ''
        $units = @{ s = 1; m = 60; h = 3600; d = 86400; w = 604800 }
        $pattern = '^(\d+(?:\.\d+)?)(seconds|second|secs|sec|s|minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d|weeks|week|wks|wk|w)'
        $invalid = "Invalid duration '$Duration': use seconds or a value like 30s, 10m, 2h, 1d or 1h30m."
        if ($text -match '^\d+(\.\d+)?$') {
            $total = [double]$text
        } else {
            if ($text -eq '') {
                throw $invalid
            }
            $total = 0.0
            $rest = $text
            while ($rest -ne '') {
                if ($rest -notmatch $pattern) {
                    throw $invalid
                }
                $total += [double]$Matches[1] * $units[$Matches[2].Substring(0, 1)]
                $rest = $rest.Substring($Matches[0].Length)
            }
        }
    }
    if ($total -lt 0) {
        throw "Invalid duration '$Duration': it cannot be negative."
    }
    if ($total -eq [math]::Floor($total)) {
        return [long]$total
    }
    return $total
}

function Resolve-AutomatorRecipient {
    <#
    .SYNOPSIS
    Turns a phone number, contact name or group into the API's recipient object.

    .DESCRIPTION
    Accepts +15551234567 (spaces, dashes, dots and brackets are ignored), a Signal
    ACI uuid, contact:<id>, a contact name as shown in the web UI (not case-sensitive),
    or group:<group name or id>. With -Group, -To is always a group name or id.

    .PARAMETER To
    The recipient.

    .PARAMETER Group
    Treat -To as a group name or id.

    .PARAMETER BaseUrl
    The server; see Get-AutomatorBaseUrl.

    .EXAMPLE
    Resolve-AutomatorRecipient 'group:Book club'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$To,

        [switch]$Group,

        [string]$BaseUrl
    )
    $text = $To.Trim()
    $isGroup = [bool]$Group
    if ($text -match '^group:(.+)$') {
        $isGroup = $true
        $text = $Matches[1].Trim()
    } elseif ($text -match '^contact:(.+)$') {
        return [ordered]@{ kind = 'contact'; id = $Matches[1].Trim() }
    }
    if (-not $isGroup) {
        $number = $text -replace '[\s().-]', ''
        if ($number -match '^\+\d{6,15}$') {
            return [ordered]@{ kind = 'contact'; id = $number }
        }
        if ($text -match '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
            return [ordered]@{ kind = 'contact'; id = $text.ToLowerInvariant() }
        }
    }
    $state = Invoke-AutomatorApi -Path '/api/state' -BaseUrl $BaseUrl
    if (-not $isGroup) {
        $contacts = @($state.contacts | Where-Object { $_.PSObject.Properties['name'] -and $_.name -eq $text })
        if ($contacts.Count -eq 1) {
            return [ordered]@{ kind = 'contact'; id = [string]$contacts[0].id }
        }
        if ($contacts.Count -gt 1) {
            throw "Several contacts are named '$text' ($(($contacts | ForEach-Object { $_.id }) -join ', ')); use the number instead."
        }
    }
    $groups = @($state.groups | Where-Object { $_.id -eq $text -or $_.name -eq $text })
    if ($groups.Count -eq 1) {
        return [ordered]@{ kind = 'group'; id = [string]$groups[0].id }
    }
    if ($groups.Count -gt 1) {
        throw "Several groups are named '$text'; use the group id instead (Get-AutomatorGroup lists them)."
    }
    if ($isGroup) {
        return [ordered]@{ kind = 'group'; id = $text }
    }
    throw "Unknown contact '$To'. Use a number in international format (+15551234567), a contact name, or group:<name>. Get-AutomatorContact lists the contacts."
}

function Get-AutomatorStatus {
    <#
    .SYNOPSIS
    Shows whether the automator is connected to Signal (transport kind, state, account).
    #>
    [CmdletBinding()]
    param([string]$BaseUrl)
    Invoke-AutomatorApi -Path '/api/status' -BaseUrl $BaseUrl
}

function Get-AutomatorState {
    <#
    .SYNOPSIS
    Returns the full state: status, contacts, groups, repeaters, rules, scripts, messages and logs.
    #>
    [CmdletBinding()]
    param([string]$BaseUrl)
    Invoke-AutomatorApi -Path '/api/state' -BaseUrl $BaseUrl
}

function Get-AutomatorContact {
    <#
    .SYNOPSIS
    Lists the contacts known to the automator.

    .PARAMETER Name
    Only contacts whose name or number matches this wildcard pattern.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name = '*',

        [string]$BaseUrl
    )
    (Invoke-AutomatorApi -Path '/api/state' -BaseUrl $BaseUrl).contacts |
        Where-Object { $_.id -like $Name -or ($_.PSObject.Properties['name'] -and $_.name -like $Name) }
}

function Get-AutomatorGroup {
    <#
    .SYNOPSIS
    Lists the Signal groups known to the automator.

    .PARAMETER Name
    Only groups whose name matches this wildcard pattern.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name = '*',

        [string]$BaseUrl
    )
    (Invoke-AutomatorApi -Path '/api/state' -BaseUrl $BaseUrl).groups | Where-Object { $_.name -like $Name }
}

function Update-AutomatorContact {
    <#
    .SYNOPSIS
    Asks signal-cli for fresh contact and group lists (the web UI's Refresh contacts button).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$BaseUrl)
    if ($PSCmdlet.ShouldProcess('contacts and groups', 'Reload from signal-cli')) {
        Invoke-AutomatorApi -Method POST -Path '/api/contacts/refresh' -BaseUrl $BaseUrl
    }
}

function Get-AutomatorMessage {
    <#
    .SYNOPSIS
    Returns messages from the automator's log, newest first.

    .PARAMETER Limit
    At most this many messages (the server keeps the last 500).

    .PARAMETER Direction
    Only incoming or only outgoing messages.
    #>
    [CmdletBinding()]
    param(
        [ValidateRange(1, 500)]
        [int]$Limit = 20,

        [ValidateSet('incoming', 'outgoing')]
        [string]$Direction,

        [string]$BaseUrl
    )
    $messages = Invoke-AutomatorApi -Path '/api/messages' -Query @{ limit = $Limit } -BaseUrl $BaseUrl
    if ($Direction) {
        $messages = $messages | Where-Object { $_.direction -eq $Direction }
    }
    $messages
}

function Watch-AutomatorMessage {
    <#
    .SYNOPSIS
    Writes new messages to the pipeline as they arrive, until Ctrl+C.

    .PARAMETER IntervalSeconds
    How often to ask the server (default 2).

    .PARAMETER Direction
    Only incoming or only outgoing messages.

    .EXAMPLE
    Watch-AutomatorMessage -Direction incoming | ForEach-Object { "$($_.senderName): $($_.body)" }
    #>
    [CmdletBinding()]
    param(
        [ValidateRange(1, 3600)]
        [int]$IntervalSeconds = 2,

        [ValidateSet('incoming', 'outgoing')]
        [string]$Direction,

        [string]$BaseUrl
    )
    $seen = New-Object -TypeName 'System.Collections.Generic.HashSet[string]'
    foreach ($message in @(Invoke-AutomatorApi -Path '/api/messages' -Query @{ limit = 100 } -BaseUrl $BaseUrl)) {
        $null = $seen.Add([string]$message.id)
    }
    while ($true) {
        Start-Sleep -Seconds $IntervalSeconds
        $batch = @(Invoke-AutomatorApi -Path '/api/messages' -Query @{ limit = 100 } -BaseUrl $BaseUrl)
        [array]::Reverse($batch)
        foreach ($message in $batch) {
            if ($seen.Add([string]$message.id) -and (-not $Direction -or $message.direction -eq $Direction)) {
                $message
            }
        }
    }
}

function Send-AutomatorMessage {
    <#
    .SYNOPSIS
    Sends a Signal message through the automator (outgoing scripts run first, as for the web UI).

    .PARAMETER To
    A number (+15551234567), a contact name, contact:<id> or group:<name or id>.

    .PARAMETER Message
    The text. Several values, or pipeline input, are sent as separate messages.

    .PARAMETER Group
    Treat -To as a group name or id.

    .EXAMPLE
    Send-AutomatorMessage -To Alice -Message 'Build finished'

    .EXAMPLE
    'Dinner is ready' | Send-AutomatorMessage -To Family -Group
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$To,

        [Parameter(Mandatory = $true, Position = 1, ValueFromPipeline = $true)]
        [string[]]$Message,

        [switch]$Group,

        [string]$BaseUrl
    )
    begin {
        $recipient = Resolve-AutomatorRecipient -To $To -Group:$Group -BaseUrl $BaseUrl
    }
    process {
        foreach ($text in $Message) {
            if ($PSCmdlet.ShouldProcess("$($recipient.kind) $($recipient.id)", 'Send Signal message')) {
                $sent = Invoke-AutomatorApi -Method POST -Path '/api/send' -Body ([ordered]@{ to = $recipient; body = $text }) -BaseUrl $BaseUrl
                if ($sent.PSObject.Properties['ok'] -and $sent.ok -eq $false) {
                    Write-Error -Message "Signal did not accept the message: $($sent.error)"
                }
                $sent
            }
        }
    }
}

function Get-AutomatorRepeater {
    <#
    .SYNOPSIS
    Lists repeaters (messages sent again and again with a countdown pause).

    .PARAMETER Name
    Only repeaters whose name or id matches this wildcard pattern.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name = '*',

        [string]$BaseUrl
    )
    Invoke-AutomatorApi -Path '/api/repeaters' -BaseUrl $BaseUrl | Where-Object { $_.name -like $Name -or $_.id -like $Name }
}

function New-AutomatorRepeater {
    <#
    .SYNOPSIS
    Creates a repeater: sends a message (or a rotation of messages) every -Every.

    .PARAMETER To
    One or more recipients (see Resolve-AutomatorRecipient).

    .PARAMETER Message
    One or more texts, sent in rotation.

    .PARAMETER Every
    The countdown pause between sends: seconds or a value like 30s, 10m, 2h, 1d.

    .PARAMETER Jitter
    Optional random extra time added to each pause (same format).

    .PARAMETER MaxRuns
    Stop and disable after this many sends (default: forever).

    .PARAMETER Name
    A name for the web UI (default: the start of the first message).

    .PARAMETER Disabled
    Create it switched off.

    .PARAMETER Group
    Treat the -To values as group names or ids.

    .EXAMPLE
    New-AutomatorRepeater -To +15551234567 -Message 'Drink some water' -Every 2h

    .EXAMPLE
    New-AutomatorRepeater -To 'group:Standup' -Message 'Standup in 5 minutes', 'Standup time!' -Every 1d -Jitter 5m
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$To,

        [Parameter(Mandatory = $true)]
        [string[]]$Message,

        [Parameter(Mandatory = $true)]
        [object]$Every,

        [object]$Jitter = 0,

        [ValidateRange(1, 2147483647)]
        [int]$MaxRuns,

        [string]$Name,

        [switch]$Disabled,

        [switch]$Group,

        [string]$BaseUrl
    )
    $recipients = @(foreach ($target in $To) { Resolve-AutomatorRecipient -To $target -Group:$Group -BaseUrl $BaseUrl })
    if (-not $Name) {
        $Name = $Message[0]
        if ($Name.Length -gt 40) {
            $Name = $Name.Substring(0, 39) + '...'
        }
    }
    $maxRunsValue = $null
    if ($PSBoundParameters.ContainsKey('MaxRuns')) {
        $maxRunsValue = $MaxRuns
    }
    $body = [ordered]@{
        name            = $Name
        enabled         = -not $Disabled
        recipients      = $recipients
        messages        = @($Message)
        intervalSeconds = ConvertTo-AutomatorSeconds $Every
        jitterSeconds   = ConvertTo-AutomatorSeconds $Jitter
        maxRuns         = $maxRunsValue
    }
    if ($PSCmdlet.ShouldProcess($Name, 'Create repeater')) {
        Invoke-AutomatorApi -Method POST -Path '/api/repeaters' -Body $body -BaseUrl $BaseUrl
    }
}

function Set-AutomatorRepeater {
    <#
    .SYNOPSIS
    Changes a repeater. Only the parameters you pass are changed.

    .PARAMETER Id
    The repeater's id (pipe in objects from Get-AutomatorRepeater).

    .PARAMETER MaxRuns
    0 removes the limit.

    .PARAMETER Property
    Any other API fields to set, for example @{ jitterSeconds = 60 }.

    .EXAMPLE
    Get-AutomatorRepeater 'Water' | Set-AutomatorRepeater -Every 90m
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$Name,

        [string[]]$Message,

        [object]$Every,

        [object]$Jitter,

        [ValidateRange(0, 2147483647)]
        [int]$MaxRuns,

        [string[]]$To,

        [switch]$Group,

        [bool]$Enabled,

        [hashtable]$Property,

        [string]$BaseUrl
    )
    process {
        $body = [ordered]@{}
        if ($PSBoundParameters.ContainsKey('Name')) { $body.name = $Name }
        if ($PSBoundParameters.ContainsKey('Message')) { $body.messages = @($Message) }
        if ($PSBoundParameters.ContainsKey('Every')) { $body.intervalSeconds = ConvertTo-AutomatorSeconds $Every }
        if ($PSBoundParameters.ContainsKey('Jitter')) { $body.jitterSeconds = ConvertTo-AutomatorSeconds $Jitter }
        if ($PSBoundParameters.ContainsKey('MaxRuns')) {
            $body.maxRuns = $null
            if ($MaxRuns -gt 0) { $body.maxRuns = $MaxRuns }
        }
        if ($PSBoundParameters.ContainsKey('To')) {
            $body.recipients = @(foreach ($target in $To) { Resolve-AutomatorRecipient -To $target -Group:$Group -BaseUrl $BaseUrl })
        }
        if ($PSBoundParameters.ContainsKey('Enabled')) { $body.enabled = $Enabled }
        if ($Property) {
            foreach ($key in $Property.Keys) { $body[$key] = $Property[$key] }
        }
        if ($body.Count -eq 0) {
            throw 'Nothing to change: pass at least one of -Name, -Message, -Every, -Jitter, -MaxRuns, -To, -Enabled or -Property.'
        }
        if ($PSCmdlet.ShouldProcess($Id, 'Update repeater')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/repeaters/$([uri]::EscapeDataString($Id))" -Body $body -BaseUrl $BaseUrl
        }
    }
}

function Enable-AutomatorRepeater {
    <#
    .SYNOPSIS
    Switches a repeater on; its countdown starts again.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Enable repeater')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/repeaters/$([uri]::EscapeDataString($Id))" -Body @{ enabled = $true } -BaseUrl $BaseUrl
        }
    }
}

function Disable-AutomatorRepeater {
    <#
    .SYNOPSIS
    Switches a repeater off.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Disable repeater')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/repeaters/$([uri]::EscapeDataString($Id))" -Body @{ enabled = $false } -BaseUrl $BaseUrl
        }
    }
}

function Invoke-AutomatorRepeater {
    <#
    .SYNOPSIS
    Sends a repeater's next message now and restarts its countdown (the web UI's Run now button).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Run repeater now')) {
            Invoke-AutomatorApi -Method POST -Path "/api/repeaters/$([uri]::EscapeDataString($Id))/run" -BaseUrl $BaseUrl
        }
    }
}

function Remove-AutomatorRepeater {
    <#
    .SYNOPSIS
    Deletes a repeater.
    #>
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Delete repeater')) {
            Invoke-AutomatorApi -Method DELETE -Path "/api/repeaters/$([uri]::EscapeDataString($Id))" -BaseUrl $BaseUrl
        }
    }
}

function ConvertTo-AutomatorRuleAction {
    # Builds the "action" object of a keyword rule from -Reply, -SendTo/-Text or -Command
    # ($Bound is the caller's $PSBoundParameters).
    param([System.Collections.Generic.Dictionary[string, object]]$Bound, [switch]$Group, [string]$BaseUrl)
    if ($Bound.ContainsKey('Reply')) {
        return [ordered]@{ type = 'reply'; text = [string]$Bound['Reply'] }
    }
    if ($Bound.ContainsKey('SendTo')) {
        if (-not $Bound.ContainsKey('Text')) {
            throw '-SendTo needs -Text, the message to send.'
        }
        $target = Resolve-AutomatorRecipient -To ([string]$Bound['SendTo']) -Group:$Group -BaseUrl $BaseUrl
        return [ordered]@{ type = 'send'; to = $target; text = [string]$Bound['Text'] }
    }
    if ($Bound.ContainsKey('Command')) {
        return [ordered]@{ type = 'script'; command = [string]$Bound['Command'] }
    }
    if ($Bound.ContainsKey('Text')) {
        throw '-Text is the message for -SendTo; to change a reply use -Reply.'
    }
    return $null
}

function Get-AutomatorRule {
    <#
    .SYNOPSIS
    Lists keyword rules in the order they are checked.

    .PARAMETER Name
    Only rules whose name, pattern or id matches this wildcard pattern.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name = '*',

        [string]$BaseUrl
    )
    Invoke-AutomatorApi -Path '/api/rules' -BaseUrl $BaseUrl |
        Where-Object { $_.name -like $Name -or $_.pattern -like $Name -or $_.id -like $Name }
}

function New-AutomatorRule {
    <#
    .SYNOPSIS
    Creates a keyword rule that reacts to matching incoming messages.

    .DESCRIPTION
    Choose one action: -Reply (answer in the same chat), -SendTo with -Text (send to
    someone else) or -Command (run a bot.command() from a script). Texts are templates:
    {{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}} {{1}}..{{9}}.

    .PARAMETER Pattern
    The keyword, phrase or regular expression.

    .PARAMETER Match
    contains (default), exact, startsWith, word or regex.

    .PARAMETER Scope
    all (default), direct (1:1 chats) or groups.

    .PARAMETER From
    Only react to these senders (numbers or uuids).

    .PARAMETER Cooldown
    Minimum time between triggers per conversation, e.g. 10m.

    .PARAMETER StopProcessing
    Do not check later rules after this one matches.

    .EXAMPLE
    New-AutomatorRule -Pattern 'opening hours' -Reply 'We are open 9:00-17:00, {{senderName}}.' -Cooldown 1h

    .EXAMPLE
    New-AutomatorRule -Pattern remind -Match startsWith -Command remind -Scope direct
    #>
    [CmdletBinding(DefaultParameterSetName = 'Reply', SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Pattern,

        [Parameter(Mandatory = $true, ParameterSetName = 'Reply')]
        [string]$Reply,

        [Parameter(Mandatory = $true, ParameterSetName = 'Send')]
        [string]$SendTo,

        [Parameter(Mandatory = $true, ParameterSetName = 'Send')]
        [string]$Text,

        [Parameter(Mandatory = $true, ParameterSetName = 'Command')]
        [string]$Command,

        [ValidateSet('contains', 'exact', 'startsWith', 'word', 'regex')]
        [string]$Match = 'contains',

        [ValidateSet('all', 'direct', 'groups')]
        [string]$Scope = 'all',

        [string[]]$From = @(),

        [object]$Cooldown = 0,

        [switch]$CaseSensitive,

        [switch]$StopProcessing,

        [string]$Name,

        [switch]$Disabled,

        [switch]$Group,

        [string]$BaseUrl
    )
    if (-not $Name) {
        $Name = $Pattern
    }
    $body = [ordered]@{
        name            = $Name
        enabled         = -not $Disabled
        pattern         = $Pattern
        matchType       = $script:MatchTypes[$Match.ToLowerInvariant()]
        caseSensitive   = [bool]$CaseSensitive
        scope           = $Scope.ToLowerInvariant()
        fromFilter      = @($From)
        action          = ConvertTo-AutomatorRuleAction -Bound $PSBoundParameters -Group:$Group -BaseUrl $BaseUrl
        cooldownSeconds = ConvertTo-AutomatorSeconds $Cooldown
        stopProcessing  = [bool]$StopProcessing
    }
    if ($PSCmdlet.ShouldProcess($Name, 'Create keyword rule')) {
        Invoke-AutomatorApi -Method POST -Path '/api/rules' -Body $body -BaseUrl $BaseUrl
    }
}

function Set-AutomatorRule {
    <#
    .SYNOPSIS
    Changes a keyword rule. Only the parameters you pass are changed.

    .PARAMETER Id
    The rule's id (pipe in objects from Get-AutomatorRule).

    .PARAMETER Property
    Any other API fields to set, for example @{ fromFilter = @('+15551234567') }.

    .EXAMPLE
    Get-AutomatorRule 'opening hours' | Set-AutomatorRule -Reply 'Closed for the holidays!'
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$Name,

        [string]$Pattern,

        [ValidateSet('contains', 'exact', 'startsWith', 'word', 'regex')]
        [string]$Match,

        [ValidateSet('all', 'direct', 'groups')]
        [string]$Scope,

        [string[]]$From,

        [object]$Cooldown,

        [bool]$CaseSensitive,

        [bool]$StopProcessing,

        [bool]$Enabled,

        [string]$Reply,

        [string]$SendTo,

        [string]$Text,

        [string]$Command,

        [switch]$Group,

        [hashtable]$Property,

        [string]$BaseUrl
    )
    process {
        $body = [ordered]@{}
        if ($PSBoundParameters.ContainsKey('Name')) { $body.name = $Name }
        if ($PSBoundParameters.ContainsKey('Pattern')) { $body.pattern = $Pattern }
        if ($PSBoundParameters.ContainsKey('Match')) { $body.matchType = $script:MatchTypes[$Match.ToLowerInvariant()] }
        if ($PSBoundParameters.ContainsKey('Scope')) { $body.scope = $Scope.ToLowerInvariant() }
        if ($PSBoundParameters.ContainsKey('From')) { $body.fromFilter = @($From) }
        if ($PSBoundParameters.ContainsKey('Cooldown')) { $body.cooldownSeconds = ConvertTo-AutomatorSeconds $Cooldown }
        if ($PSBoundParameters.ContainsKey('CaseSensitive')) { $body.caseSensitive = $CaseSensitive }
        if ($PSBoundParameters.ContainsKey('StopProcessing')) { $body.stopProcessing = $StopProcessing }
        if ($PSBoundParameters.ContainsKey('Enabled')) { $body.enabled = $Enabled }
        $action = ConvertTo-AutomatorRuleAction -Bound $PSBoundParameters -Group:$Group -BaseUrl $BaseUrl
        if ($null -ne $action) { $body.action = $action }
        if ($Property) {
            foreach ($key in $Property.Keys) { $body[$key] = $Property[$key] }
        }
        if ($body.Count -eq 0) {
            throw 'Nothing to change: pass a setting such as -Pattern, -Reply, -Enabled or -Property.'
        }
        if ($PSCmdlet.ShouldProcess($Id, 'Update keyword rule')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/rules/$([uri]::EscapeDataString($Id))" -Body $body -BaseUrl $BaseUrl
        }
    }
}

function Enable-AutomatorRule {
    <#
    .SYNOPSIS
    Switches a keyword rule on.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Enable keyword rule')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/rules/$([uri]::EscapeDataString($Id))" -Body @{ enabled = $true } -BaseUrl $BaseUrl
        }
    }
}

function Disable-AutomatorRule {
    <#
    .SYNOPSIS
    Switches a keyword rule off.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Disable keyword rule')) {
            Invoke-AutomatorApi -Method PUT -Path "/api/rules/$([uri]::EscapeDataString($Id))" -Body @{ enabled = $false } -BaseUrl $BaseUrl
        }
    }
}

function Remove-AutomatorRule {
    <#
    .SYNOPSIS
    Deletes a keyword rule.
    #>
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Id,

        [string]$BaseUrl
    )
    process {
        if ($PSCmdlet.ShouldProcess($Id, 'Delete keyword rule')) {
            Invoke-AutomatorApi -Method DELETE -Path "/api/rules/$([uri]::EscapeDataString($Id))" -BaseUrl $BaseUrl
        }
    }
}

function Set-AutomatorRuleOrder {
    <#
    .SYNOPSIS
    Sets the order in which keyword rules are checked.

    .PARAMETER Id
    The ids of all rules, first to last.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string[]]$Id,

        [string]$BaseUrl
    )
    if ($PSCmdlet.ShouldProcess('keyword rules', 'Reorder')) {
        Invoke-AutomatorApi -Method POST -Path '/api/rules/reorder' -Body @{ ids = @($Id) } -BaseUrl $BaseUrl
    }
}

function Test-AutomatorRule {
    <#
    .SYNOPSIS
    Shows which rules would react to a message, and what they would send, without sending anything.

    .EXAMPLE
    Test-AutomatorRule -Message 'what are your opening hours?' -Sender +15551234567
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Message,

        [string]$Sender,

        [switch]$Group,

        [string]$BaseUrl
    )
    $body = [ordered]@{ body = $Message; group = [bool]$Group }
    if ($Sender) {
        $body.sender = $Sender
    }
    (Invoke-AutomatorApi -Method POST -Path '/api/rules/test' -Body $body -BaseUrl $BaseUrl).matches
}

function ConvertTo-AutomatorScriptName {
    # 'away' -> 'away.js'; names that already end in .js or .mjs are kept.
    param([string]$Name)
    if ($Name -match '\.m?js$') {
        return $Name
    }
    return "$Name.js"
}

function Get-AutomatorScript {
    <#
    .SYNOPSIS
    Lists the scripts, or with -Name returns one script's info and source code.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Name,

        [string]$BaseUrl
    )
    if ($Name -and -not [System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Name)) {
        $file = ConvertTo-AutomatorScriptName $Name
        return Invoke-AutomatorApi -Path "/api/scripts/$([uri]::EscapeDataString($file))" -BaseUrl $BaseUrl
    }
    if (-not $Name) {
        $Name = '*'
    }
    Invoke-AutomatorApi -Path '/api/scripts' -BaseUrl $BaseUrl | Where-Object { $_.name -like $Name }
}

function Set-AutomatorScript {
    <#
    .SYNOPSIS
    Creates or replaces a script in the automator's scripts folder and (re)loads it.

    .PARAMETER Name
    The file name, e.g. my-bot.js (.js is added when missing).

    .PARAMETER Source
    The JavaScript source code.

    .PARAMETER Path
    A local file to upload instead of -Source.

    .EXAMPLE
    Set-AutomatorScript -Name greeter -Path .\greeter.js
    #>
    [CmdletBinding(DefaultParameterSetName = 'Source', SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Name,

        [Parameter(Mandatory = $true, ParameterSetName = 'Source')]
        [string]$Source,

        [Parameter(Mandatory = $true, ParameterSetName = 'Path')]
        [string]$Path,

        [string]$BaseUrl
    )
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
        $Source = [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8)
    }
    $file = ConvertTo-AutomatorScriptName $Name
    if ($PSCmdlet.ShouldProcess($file, 'Save script')) {
        Invoke-AutomatorApi -Method PUT -Path "/api/scripts/$([uri]::EscapeDataString($file))" -Body @{ source = $Source } -BaseUrl $BaseUrl
    }
}

function Remove-AutomatorScript {
    <#
    .SYNOPSIS
    Deletes a script file from the automator's scripts folder.
    #>
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Name,

        [string]$BaseUrl
    )
    process {
        $file = ConvertTo-AutomatorScriptName $Name
        if ($PSCmdlet.ShouldProcess($file, 'Delete script')) {
            Invoke-AutomatorApi -Method DELETE -Path "/api/scripts/$([uri]::EscapeDataString($file))" -BaseUrl $BaseUrl
        }
    }
}

function Enable-AutomatorScript {
    <#
    .SYNOPSIS
    Switches a script on (loads it).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Name,

        [string]$BaseUrl
    )
    process {
        $file = ConvertTo-AutomatorScriptName $Name
        if ($PSCmdlet.ShouldProcess($file, 'Enable script')) {
            Invoke-AutomatorApi -Method POST -Path "/api/scripts/$([uri]::EscapeDataString($file))/enable" -Body @{ enabled = $true } -BaseUrl $BaseUrl
        }
    }
}

function Disable-AutomatorScript {
    <#
    .SYNOPSIS
    Switches a script off (unloads it; the file stays).
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true, Position = 0, ValueFromPipelineByPropertyName = $true)]
        [string]$Name,

        [string]$BaseUrl
    )
    process {
        $file = ConvertTo-AutomatorScriptName $Name
        if ($PSCmdlet.ShouldProcess($file, 'Disable script')) {
            Invoke-AutomatorApi -Method POST -Path "/api/scripts/$([uri]::EscapeDataString($file))/enable" -Body @{ enabled = $false } -BaseUrl $BaseUrl
        }
    }
}

function Update-AutomatorScript {
    <#
    .SYNOPSIS
    Reloads all scripts from disk (the web UI's Reload all button), after editing files directly.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$BaseUrl)
    if ($PSCmdlet.ShouldProcess('all scripts', 'Reload from disk')) {
        Invoke-AutomatorApi -Method POST -Path '/api/scripts/reload' -BaseUrl $BaseUrl
    }
}

function Invoke-AutomatorSimulation {
    <#
    .SYNOPSIS
    Injects a pretend incoming message so you can try rules and scripts.

    .DESCRIPTION
    Rules and scripts react as if the message had really arrived. In mock mode nothing
    is sent; with a real Signal connection their replies ARE sent, so a warning is shown.

    .PARAMETER From
    The pretend sender: a number (+15550000001), a uuid or a contact name.

    .PARAMETER Message
    The text of the pretend message.

    .PARAMETER GroupId
    Pretend the message was sent in this group (group name or id).

    .PARAMETER BaseUrl
    The server; see Get-AutomatorBaseUrl.

    .EXAMPLE
    Invoke-AutomatorSimulation -From +15550000001 -Message ping

    .EXAMPLE
    Invoke-AutomatorSimulation -From Alice -GroupId 'Test Group' -Message 'ping'
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)]
        [string]$From,

        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Message,

        [string]$GroupId,

        [string]$BaseUrl
    )
    $fromRecipient = Resolve-AutomatorRecipient -To $From -BaseUrl $BaseUrl
    if ($fromRecipient.kind -ne 'contact') {
        throw "-From must be a contact (a number, uuid or contact name), not a group. Use -GroupId for the group."
    }
    $body = [ordered]@{ from = $fromRecipient.id; body = $Message }
    $where = $fromRecipient.id
    if ($GroupId) {
        $body.groupId = (Resolve-AutomatorRecipient -To $GroupId -Group -BaseUrl $BaseUrl).id
        $where = "$($fromRecipient.id) in group $GroupId"
    }
    if (-not $PSCmdlet.ShouldProcess($where, "Simulate incoming message '$Message'")) {
        return
    }
    $status = Invoke-AutomatorApi -Path '/api/status' -BaseUrl $BaseUrl
    if ($status.kind -ne 'mock') {
        Write-Warning 'Not in mock mode: replies triggered by this simulated message are really sent.'
    }
    Invoke-AutomatorApi -Method POST -Path '/api/simulate/incoming' -Body $body -BaseUrl $BaseUrl
}

Export-ModuleMember -Function @(
    'Get-AutomatorBaseUrl'
    'Invoke-AutomatorApi'
    'ConvertTo-AutomatorSeconds'
    'Resolve-AutomatorRecipient'
    'Get-AutomatorStatus'
    'Get-AutomatorState'
    'Get-AutomatorContact'
    'Get-AutomatorGroup'
    'Update-AutomatorContact'
    'Get-AutomatorMessage'
    'Watch-AutomatorMessage'
    'Send-AutomatorMessage'
    'Get-AutomatorRepeater'
    'New-AutomatorRepeater'
    'Set-AutomatorRepeater'
    'Enable-AutomatorRepeater'
    'Disable-AutomatorRepeater'
    'Invoke-AutomatorRepeater'
    'Remove-AutomatorRepeater'
    'Get-AutomatorRule'
    'New-AutomatorRule'
    'Set-AutomatorRule'
    'Enable-AutomatorRule'
    'Disable-AutomatorRule'
    'Remove-AutomatorRule'
    'Set-AutomatorRuleOrder'
    'Test-AutomatorRule'
    'Get-AutomatorScript'
    'Set-AutomatorScript'
    'Remove-AutomatorScript'
    'Enable-AutomatorScript'
    'Disable-AutomatorScript'
    'Update-AutomatorScript'
    'Invoke-AutomatorSimulation'
)
