<#
.SYNOPSIS
Calls the Signal Automator REST API from the command line.

.DESCRIPTION
A thin wrapper around Invoke-AutomatorApi from SignalAutomator.psm1 (in this
folder): it sends one request to the running automator and writes the parsed
JSON response to the pipeline, or prints it as JSON with -AsJson.

For day-to-day scripting import the module instead, which adds commands such as
Send-AutomatorMessage, New-AutomatorRepeater, New-AutomatorRule and
Get-AutomatorMessage:

    Import-Module .\powershell\SignalAutomator.psm1
    Get-Command -Module SignalAutomator

The routes are listed in docs/rest-api.md. Works with Windows PowerShell 5.1 and
PowerShell 7 on any operating system.

.PARAMETER Path
The API path, for example /api/status, /api/messages?limit=5 or /api/repeaters/<id>/run.

.PARAMETER Method
GET (default), POST, PUT or DELETE.

.PARAMETER Body
The request body: a hashtable or object (sent as JSON) or a string that already
contains JSON (handy with powershell.exe -File, which passes only strings).

.PARAMETER Query
Query string parameters, for example @{ limit = 5 }.

.PARAMETER BaseUrl
The automator's address. Default: $env:AUTOMATOR_URL, else
http://<AUTOMATOR_HOST or 127.0.0.1>:<AUTOMATOR_PORT or 7583>.

.PARAMETER AsJson
Print the response as indented JSON text instead of writing objects.

.EXAMPLE
.\Invoke-Automator.ps1 /api/status

.EXAMPLE
.\Invoke-Automator.ps1 /api/messages -Query @{ limit = 5 } | Format-Table timestamp, direction, body

.EXAMPLE
.\Invoke-Automator.ps1 -Method PUT -Path /api/rules/0b6f6c1e-3c1f-4d5e-9b0f-2f6d6a1b2c3d -Body @{ enabled = $false }

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\Invoke-Automator.ps1 -Method POST -Path /api/send -Body '{"to":{"kind":"contact","id":"+15551234567"},"body":"Hi"}' -AsJson

.NOTES
Errors from the API stop the script with the HTTP status and the server's message.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,

    [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
    [string]$Method = 'GET',

    [object]$Body,

    [hashtable]$Query,

    [string]$BaseUrl,

    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path -Path $PSScriptRoot -ChildPath 'SignalAutomator.psm1') -Scope Local

$request = @{ Method = $Method; Path = $Path }
if ($PSBoundParameters.ContainsKey('Body')) { $request.Body = $Body }
if ($Query) { $request.Query = $Query }
if ($BaseUrl) { $request.BaseUrl = $BaseUrl }

if ($AsJson) {
    $result = @(Invoke-AutomatorApi @request)
    if ($result.Count -eq 1) {
        ConvertTo-Json -InputObject $result[0] -Depth 10
    } elseif ($result.Count -gt 1) {
        ConvertTo-Json -InputObject $result -Depth 10
    }
} else {
    Invoke-AutomatorApi @request
}
