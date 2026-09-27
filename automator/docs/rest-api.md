# Signal Automator REST API

The web UI, the Python client and the PowerShell module all use this API, and your own
programs can use it too. The TypeScript types behind it are in
[`shared/src/index.ts`](../shared/src/index.ts), which is the source of truth.

Contents:

- [Basics](#basics)
- [Status, contacts and messages](#status-contacts-and-messages)
- [Sending](#sending)
- [Repeaters](#repeaters)
- [Keyword rules](#keyword-rules)
- [Scripts](#scripts)
- [Simulating incoming messages](#simulating-incoming-messages)
- [Live updates: WebSocket](#live-updates-websocket)
- [Examples in other languages](#examples-in-other-languages)

## Basics

- **Base URL.** The default is `http://127.0.0.1:7583`. `AUTOMATOR_HOST` and
  `AUTOMATOR_PORT` change it. Every endpoint is under `/api`.
- **Format.**
  - Requests and responses are JSON in UTF-8. Send `Content-Type: application/json`.
  - Request bodies can be up to 2 MB.
  - Times are milliseconds since the Unix epoch, as Signal uses them.
- **No authentication.** Anything that can reach the port has full control; see
  [Security](../README.md#security).
- **Host and Origin checks.** Requests must use a local host name: `127.0.0.1`,
  `localhost`, `::1`, or the address set in `AUTOMATOR_HOST`. If a request sends an
  `Origin` header, its host must also be one of those. Anything else gets
  `403 {"error": "forbidden host or origin"}`.
- **Startup.** The server answers `GET /api/status` as soon as it listens. Other requests
  wait until it has loaded its state, and get `503` if loading failed.

Recipients are always objects:

```json
{ "kind": "contact", "id": "+15551234567" }
{ "kind": "group",   "id": "bW9jay1ncm91cC0xAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
```

- A **contact id** is a phone number in international format. For contacts without a
  known number, it's their Signal ACI (a UUID).
- A **group id** is the base64 id that signal-cli reports.
- The API doesn't accept names. Look names up in `GET /api/state` (`contacts`,
  `groups`). The Python and PowerShell clients do this for you.

Errors come back as a non-2xx status with a JSON body such as
`{"error": "intervalSeconds must be >= 1"}`:

| Status | Meaning |
|---|---|
| `400` | The input is invalid. The message says what's wrong. |
| `403` | The `Host` or `Origin` isn't allowed (see above). |
| `404` | There's no repeater, rule or script with that id or name, or no such endpoint. |
| `409` | An outgoing script hook cancelled the message. |
| `500` | Anything else. Errors from signal-cli look like `signal-cli send: ...`. |
| `503` | The server failed to start. |

## Status, contacts and messages

| Method and path | Returns |
|---|---|
| `GET /api/status` | The Signal connection: `{kind, state, account, detail}`. |
| `GET /api/state` | Everything at once: `{status, contacts, groups, repeaters, rules, scripts, messages, logs}`. |
| `POST /api/contacts/refresh` | Reloads contacts and groups from signal-cli, and returns `{contacts, groups}`. |
| `GET /api/messages?limit=N` | The message log, newest first. The server keeps the last 500. |

`GET /api/status`:

```json
{ "kind": "signal-cli", "state": "connected", "account": "+15551234567", "detail": null }
```

- `kind` is `signal-cli` or `mock`.
- `state` is `disconnected`, `connecting`, `connected` or `error`.
- `detail` explains the state, for example why the connection failed.

Contacts and groups look like this:

```json
{ "id": "+15550000001", "number": "+15550000001", "uuid": "...", "name": "Alice" }
{ "id": "bW9jay1ncm91cC0xAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "name": "Test Group", "memberCount": 3 }
```

A message in the log:

```json
{
  "id": "1790536115589-outgoing-+15550000001",
  "direction": "outgoing",
  "timestamp": 1790536115589,
  "peer": { "kind": "contact", "id": "+15550000001" },
  "body": "pong",
  "origin": "script",
  "originRef": "00-example-ping.js",
  "ok": true
}
```

- `peer` is the conversation: the other person, or the group.
- Incoming messages have `sender` and, when it's known, `senderName`.
- Outgoing messages have:
  - `origin`: `manual`, `repeater`, `keyword`, `script`, or `external` (sent from
    another of your devices);
  - `originRef`: the id of the repeater or rule, or the script's name;
  - `ok`, and `error` when sending failed.

The logs in `GET /api/state` look like this:

```json
{ "timestamp": 1790536115589, "level": "info", "source": "transport", "message": "..." }
```

The last 200 log entries are kept. `level` is `debug`, `info`, `warn` or `error`.

## Sending

`POST /api/send` with `{"to": <recipient>, "body": "text"}` sends a message now.

- On success, it returns the logged message, with the timestamp Signal gave it.
- Outgoing script hooks run first. A hook may change the text, or cancel the send, which
  gives `409`.
- If signal-cli rejects the message, you get `500` with signal-cli's error. The failed
  attempt is still logged, with `"ok": false`.

```sh
curl -s http://127.0.0.1:7583/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to": {"kind": "contact", "id": "+15551234567"}, "body": "Hello from curl"}'
```

## Repeaters

A repeater sends a message again and again, with a pause in between.

```json
{
  "id": "0f1c2d3e-...",
  "name": "Drink water",
  "enabled": true,
  "recipients": [{ "kind": "contact", "id": "+15551234567" }],
  "messages": ["Drink water", "Stretch your legs"],
  "intervalSeconds": 3600,
  "jitterSeconds": 60,
  "maxRuns": null,
  "runCount": 4,
  "nextRunAt": 1790540577328,
  "lastRunAt": 1790536977328,
  "createdAt": 1790522577328
}
```

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/repeaters` | | All repeaters. |
| `POST /api/repeaters` | See the fields below. | The new repeater. |
| `PUT /api/repeaters/:id` | Any of the input fields. | The updated repeater. |
| `DELETE /api/repeaters/:id` | | `204` |
| `POST /api/repeaters/:id/run` | | The repeater, after sending its next message now and restarting the countdown. |

The input fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Shown in the UI. |
| `recipients` | yes | At least one recipient. |
| `messages` | yes | At least one non-empty text. |
| `intervalSeconds` | yes | The pause between sends: the countdown. At least 1. |
| `enabled` | no | Default `true`. |
| `jitterSeconds` | no | A random extra delay of 0 to this many seconds, added to each pause. Default `0`. |
| `maxRuns` | no | Stop after this many sends, or `null` to go on forever (the default). |

How repeaters behave:

- **Rotation.** Run number N sends `messages[N % messages.length]` to every recipient.
- **First send.** The first send happens when the first countdown ends, not at once.
  Use `/run` to send immediately.
- **Countdown restarts.** Changing `enabled`, `intervalSeconds` or `jitterSeconds`
  restarts the countdown.
- **Finishing.**
  - After `maxRuns` sends, the repeater switches itself off.
  - Switching a finished repeater back on starts it over, from run 0.
- **Restarts.** Countdowns continue across server restarts. A send that came due while
  the server was stopped goes out once, soon after the next start.

Example:

```sh
curl -s http://127.0.0.1:7583/api/repeaters -H 'Content-Type: application/json' -d '{
  "name": "Stand-up",
  "recipients": [{"kind": "group", "id": "bW9jay1ncm91cC0xAAAAAAAAAAAAAAAAAAAAAAAAAAA="}],
  "messages": ["Stand-up in 5 minutes"],
  "intervalSeconds": 86400
}'
```

## Keyword rules

Rules are checked against every incoming message in list order. A rule whose scope,
sender filter and pattern all match, and that isn't cooling down, runs its action.

```json
{
  "id": "5a4b...",
  "name": "Opening hours",
  "enabled": true,
  "pattern": "opening hours",
  "matchType": "contains",
  "caseSensitive": false,
  "scope": "direct",
  "fromFilter": [],
  "action": { "type": "reply", "text": "Hi {{senderName}}, we're open 9-5." },
  "cooldownSeconds": 3600,
  "stopProcessing": false,
  "triggerCount": 12,
  "lastTriggeredAt": 1790536977328,
  "createdAt": 1790522577328
}
```

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/rules` | | All rules, in the order they're checked. |
| `POST /api/rules` | See the fields below. | The new rule, added at the end. |
| `PUT /api/rules/:id` | Any of the input fields. | The updated rule. |
| `DELETE /api/rules/:id` | | `204` |
| `POST /api/rules/reorder` | `{"ids": [...]}`, with every existing rule id exactly once. | The rules, in their new order. |
| `POST /api/rules/test` | `{"body": "text", "sender": "+1555...", "group": false}`. `sender` and `group` are optional. | `{"matches": [{"ruleId", "output"}]}`. This is a dry run of the enabled rules: nothing is sent, and cooldowns are ignored. `output` is the text that would be sent, or `null` for script actions. |

The input fields. Only `pattern` and `action` are required:

| Field | Default | Meaning |
|---|---|---|
| `pattern` | | The text to look for, or a regular expression. |
| `action` | | What to do; see below. |
| `name` | the pattern | Shown in the UI. |
| `enabled` | `true` | |
| `matchType` | `contains` | How the pattern is matched; see below. |
| `caseSensitive` | `false` | |
| `scope` | `all` | `all`, `direct` (1:1 chats only) or `groups`. |
| `fromFilter` | `[]` | Only react to these senders (numbers or UUIDs). Empty means anyone. |
| `cooldownSeconds` | `0` | Minimum time between triggers in the same conversation. |
| `stopProcessing` | `false` | When this rule matches, don't check later rules. |

The match types:

| `matchType` | Matches when the message... |
|---|---|
| `contains` | ...contains the pattern anywhere. |
| `exact` | ...is exactly the pattern, ignoring surrounding spaces. |
| `startsWith` | ...begins with the pattern, ignoring leading spaces. |
| `word` | ...contains the pattern as a whole word or phrase: `price` matches "the price?" but not "prices". |
| `regex` | ...matches the pattern as a JavaScript regular expression. It's case-insensitive unless `caseSensitive` is set. |

The actions:

| `action` | Does |
|---|---|
| `{"type": "reply", "text": "..."}` | Replies in the conversation the message came from: to the person, or to the group. |
| `{"type": "send", "to": <recipient>, "text": "..."}` | Sends to someone else, for example to forward or to notify. |
| `{"type": "script", "command": "name"}` | Runs the handler that a script registered with `bot.command('name', ...)`. |

Texts are templates:

| Placeholder | Becomes |
|---|---|
| `{{body}}` | The whole incoming message. |
| `{{sender}}` | The sender's number or id. |
| `{{senderName}}` | The sender's name, if known. |
| `{{match}}` | The text that matched. |
| `{{time}}`, `{{date}}` | The current time and date. |
| `{{1}}` to `{{9}}` | Groups captured by a `regex` pattern. |

Example:

```sh
curl -s http://127.0.0.1:7583/api/rules -H 'Content-Type: application/json' -d '{
  "pattern": "^order (\\d+)$",
  "matchType": "regex",
  "action": {"type": "send", "to": {"kind": "contact", "id": "+15557654321"}, "text": "Order {{1}} from {{senderName}}"}
}'
```

## Scripts

Scripts are the `.js` and `.mjs` files in the scripts folder. The scripting API is in
[scripts/README.md](../scripts/README.md).

```json
{
  "name": "away-autoreply.js",
  "enabled": true,
  "loaded": true,
  "error": null,
  "commands": ["away"],
  "updatedAt": 1790536977328
}
```

- `loaded` is `true` when the script's `setup()` ran without an error.
- `error` is the last load or runtime error, or `null`.
- `commands` lists the names the script registered with `bot.command()`.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/scripts` | | All scripts. |
| `GET /api/scripts/:name` | | `{"info": <script>, "source": "..."}` |
| `PUT /api/scripts/:name` | `{"source": "..."}` | Creates or overwrites the file, reloads it, and returns the script. |
| `DELETE /api/scripts/:name` | | `204`. The file is deleted. |
| `POST /api/scripts/:name/enable` | `{"enabled": true}` or `false` | The script. Turning a script off unloads it but keeps the file. |
| `POST /api/scripts/reload` | | Rescans the folder, reloads every enabled script, and returns all scripts. |

Rules for script names:

- They must match `[A-Za-z0-9._-]+`, end in `.js` or `.mjs`, and must not contain `..`.
- Names starting with `.` or `_` are reserved: `_` is for helper modules, which aren't
  loaded as scripts.

`PUT /api/scripts/:name` writes code that the server then runs with full permissions,
so access to the API means the ability to run code on your computer.

## Simulating incoming messages

`POST /api/simulate/incoming` with `{"from": "+15550000001", "body": "ping"}`, plus
`"groupId": "<group id>"` for a group message, returns `204`.

The message goes through the rules and scripts as if it had really arrived, and it
appears in the message log. Nothing is sent to Signal for the pretend message itself.
In mock mode nothing is sent at all. **With a real account, any replies it triggers are
really sent.**

## Live updates: WebSocket

Connect to `ws://127.0.0.1:7583/ws`. The same Host and Origin checks apply.

- **Events.** Each message from the server is a JSON event, and the first is always a
  full `snapshot`.
- **Client messages.** The server ignores anything the client sends.
- **Keep-alive.** It pings every 30 seconds.

| `type` | Other fields | Sent when |
|---|---|---|
| `snapshot` | `state`: the same as `GET /api/state` | Right after connecting. |
| `status` | `status` | The Signal connection changes. |
| `message` | `message` | A message is received or sent. |
| `repeaters` | `repeaters`: all of them | A repeater is created, changed, deleted or run, or its countdown changes. |
| `rules` | `rules`: all of them | A rule is created, changed, deleted or reordered, or it triggers (`triggerCount` goes up). |
| `scripts` | `scripts`: all of them | Scripts are loaded, changed or fail. |
| `contacts` | `contacts`, `groups` | The lists are refreshed. |
| `log` | `entry` | A log entry is written. |

In a browser, or Node.js 22 and newer:

```js
const ws = new WebSocket('ws://127.0.0.1:7583/ws');
ws.onmessage = (event) => {
  const ev = JSON.parse(event.data);
  if (ev.type === 'message' && ev.message.direction === 'incoming') {
    console.log(`${ev.message.senderName ?? ev.message.sender}: ${ev.message.body}`);
  }
};
```

## Examples in other languages

Python, standard library only. See also the ready-made client in
[`python/`](../python):

```python
import json
import urllib.request

request = urllib.request.Request(
    'http://127.0.0.1:7583/api/send',
    data=json.dumps({'to': {'kind': 'contact', 'id': '+15551234567'}, 'body': 'Hello'}).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST',
)
with urllib.request.urlopen(request) as response:
    print(json.load(response))
```

PowerShell. `Invoke-Automator.ps1` and the module in [`powershell/`](../powershell)
handle encoding and errors for you:

```powershell
.\powershell\Invoke-Automator.ps1 /api/send -Method POST -Body @{ to = @{ kind = 'contact'; id = '+15551234567' }; body = 'Hello' }

# Or by hand. Windows PowerShell 5.1 needs the body as UTF-8 bytes to send non-ASCII text.
$json = @{ to = @{ kind = 'contact'; id = '+15551234567' }; body = 'Hello' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7583/api/send -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
```
