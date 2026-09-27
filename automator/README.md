# Signal Automator

Signal Automator sends automated Signal messages from your own computer, as you. It
links to your existing Signal account as an extra device, the way Signal Desktop does,
and then runs:

- **Repeaters.** A message, or a rotation of messages, goes to contacts or groups again
  and again, with a live countdown until the next send. You can add a random extra delay
  and cap the number of sends.
- **Keyword catchers.** Rules watch incoming messages for a word, phrase or regular
  expression. A match can send a reply, notify someone else, or run a script command.
  Rules can have per-chat cooldowns and sender filters.
- **Scripts.** Small JavaScript modules get a `bot` API for whatever rules can't express:
  - handlers for incoming messages,
  - hooks that change or block outgoing messages,
  - commands, timers, and storage.

You manage it all in a web UI at <http://127.0.0.1:7583>. You can also use the Python
client, PowerShell, or anything else that speaks HTTP. Mock mode lets you try everything
without a phone.

Contents:

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start: Windows](#quick-start-windows)
- [Quick start: macOS and Linux](#quick-start-macos-and-linux)
- [Quick start: by hand, on any system](#quick-start-by-hand-on-any-system)
- [Try it without a phone: mock mode](#try-it-without-a-phone-mock-mode)
- [Linking your Signal account](#linking-your-signal-account)
- [Using the web UI](#using-the-web-ui)
- [Scripts](#scripts)
- [Python client](#python-client)
- [PowerShell](#powershell)
- [Configuration](#configuration)
- [Keeping it running, updating, developing](#keeping-it-running-updating-developing)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [About this folder](#about-this-folder)

## How it works

```text
    Your phone                    Signal service                  Your contacts
    (Signal app)  <---------->   (end-to-end encrypted)  <------->  and groups
                                        ^
  - - - - - - - - - - - - - - - - - - - | - - - - - - - - - - - - - - - - - - - - -
    This computer                       |
                                        v
                +--------------------------------------------------+
                |  signal-cli daemon                               |
                |  a linked device of your account, like Desktop   |
                |  http://127.0.0.1:7584  (JSON-RPC and events)    |
                +--------------------------------------------------+
                                        ^
                                        |  HTTP, this computer only
                                        v
                +--------------------------------------------------+
                |  Signal Automator server (Node.js, server/)      |
                |  repeaters - keyword rules - scripts/*.js        |
                |  state in data/state.json                        |
                |  http://127.0.0.1:7583  REST /api, WebSocket /ws |
                +--------------------------------------------------+
                     ^                  ^                   ^
                     |                  |                   |
               web UI (web/)     Python client       PowerShell module,
               in your browser   and CLI (python/)   curl, your own code
```

- **[signal-cli](https://github.com/AsamK/signal-cli)** is an unofficial command-line
  Signal client.
  - Once linked to your account, its daemon receives your messages and sends new ones.
  - It offers this on a local HTTP port: JSON-RPC calls plus a stream of events.
  - It runs as its own process: `signal-cli -a +NUMBER daemon --http 127.0.0.1:7584`.
- **The automator server** (`server/`, Node.js and TypeScript) connects to the daemon.
  - It runs the repeaters, rules and scripts, and saves its state in `data/state.json`.
  - It serves:
    - the REST API;
    - a WebSocket that pushes live updates;
    - the web UI (`web/`, React), built into `web/dist`.
- **The launcher scripts** install signal-cli, link it to your phone, and start and stop
  both processes. They live in `bin/` for macOS and Linux, and in `powershell/` for Windows.
- **Clients** use the same REST API as the web UI. There's a Python library and CLI in
  `python/`, and a PowerShell module in `powershell/`.

The automator works with text messages. By default the daemon doesn't download
attachments or stories (see `SIGNAL_CLI_DAEMON_ARGS`).

It sees messages that arrive after linking, never your older history. While the daemon
is stopped, Signal holds new messages for it. They arrive when it starts again, and
rules and scripts react to them then, late.

## Requirements

| What | Why | Notes |
|---|---|---|
| **Node.js 20 or newer**, with npm | Runs the server and builds the web UI. | Get the LTS release from <https://nodejs.org>, winget or Homebrew. |
| **signal-cli** | Talks to Signal. | The install scripts download it. Keep it up to date: old versions stop working as Signal changes. |
| **Java 21 or newer** | Runs signal-cli's Java build. | **Windows:** required. **macOS:** Homebrew installs it along with signal-cli. **Linux:** needed unless you use signal-cli's native build (x86-64 only). |
| **A phone with Signal** | Linking. | Your phone stays your main device. |
| Python 3.9 or newer | The Python client (optional). | Standard library only. |
| PowerShell 5.1 or 7 | The Windows scripts and the PowerShell module. | Windows PowerShell 5.1 comes with Windows. |
| `qrencode` | Optional. | Draws a crisper QR code in the terminal while linking. |

## Quick start: Windows

1. Install Node.js and Java if you don't have them. Afterwards, open a **new**
   PowerShell window so that it finds them:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install EclipseAdoptium.Temurin.21.JRE
   ```

2. Get this repository with `git clone`, or download the ZIP and extract it. Then open
   PowerShell in its `automator` folder:

   ```powershell
   cd C:\path\to\libsignal\automator
   ```

3. Install. This downloads signal-cli and runs `npm install` and `npm run build`:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\powershell\Install-SignalAutomator.ps1
   ```

4. Link your Signal account. A QR code appears. On your phone, open **Signal >
   Settings > Linked devices > Link new device** and scan it:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\powershell\Link-SignalDevice.ps1
   ```

5. Start. This starts the signal-cli daemon and the server in the background and
   opens <http://127.0.0.1:7583>:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\powershell\Start-SignalAutomator.ps1
   ```

6. To stop:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\powershell\Stop-SignalAutomator.ps1
   ```

To try it without a phone, skip step 4 and start with `-Mock` (see
[mock mode](#try-it-without-a-phone-mock-mode)). If you only want mock mode, you can
also skip Java: `Install-SignalAutomator.ps1 -SkipSignalCli`.

About `-ExecutionPolicy Bypass`: by default, Windows refuses to run downloaded
PowerShell scripts. The `powershell -ExecutionPolicy Bypass -File ...` form above runs
them without changing any setting. To call them as `.\powershell\Start-SignalAutomator.ps1`
instead, allow local scripts once for your user. If you downloaded a ZIP, also unblock
the files:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Get-ChildItem -Recurse .\powershell | Unblock-File
```

Each script has built-in help, for example
`Get-Help .\powershell\Start-SignalAutomator.ps1 -Detailed`.

| Script | Options |
|---|---|
| `Install-SignalAutomator.ps1` | `-SkipSignalCli`, `-ForceSignalCli` (download the latest signal-cli again), `-NoBuild` |
| `Link-SignalDevice.ps1` | `-Name 'Office PC'` (the name shown on your phone), `-Browser` (also show the QR code in the browser), `-Force` (link again) |
| `Start-SignalAutomator.ps1` | `-Mock`, `-Port 8080`, `-NoBrowser` |
| `Stop-SignalAutomator.ps1` | `-ServerOnly` (keep the signal-cli daemon running) |

## Quick start: macOS and Linux

1. Install the prerequisites:
   - **Node.js 20 or newer.** On macOS, `brew install node`. On Linux, use
     <https://nodejs.org> or your distribution, but check the version: many
     distributions still ship an older Node.js.
   - **Java 21 or newer, on Linux**, for example
     `sudo apt install openjdk-21-jre-headless`. On x86-64 Linux without Java,
     `install.sh` uses signal-cli's native build instead. On macOS, Homebrew installs
     Java together with signal-cli.
2. From the `automator` directory of this repository:

   ```sh
   bin/install.sh        # signal-cli (Homebrew on macOS), npm install, npm run build
   bin/link-device.sh    # shows a QR code: Signal > Settings > Linked devices > Link new device
   bin/start.sh          # daemon + server in the background, opens http://127.0.0.1:7583
   bin/stop.sh           # stops both
   ```

| Script | Options |
|---|---|
| `bin/install.sh` | `--skip-signal-cli` (for mock mode only), `--force-signal-cli` (download the latest again), `--no-build` |
| `bin/link-device.sh` | `--name NAME`, `--browser` (also show the QR code in the browser), `--force` (link again) |
| `bin/start.sh` | `--mock`, `--port PORT`, `--no-browser`, `--foreground` (the server runs in the terminal, and Ctrl+C stops everything) |
| `bin/stop.sh` | `--server-only` (keep the signal-cli daemon running) |

Each script prints its help with `--help`. They work with the bash 3.2 that ships with
macOS.

## Quick start: by hand, on any system

This is what the scripts do, if you'd rather see each step or already run signal-cli:

```sh
cd automator
npm install
npm run build

# Link. signal-cli prints an sgnl://linkdevice?... link and waits. In a second
# terminal, show that link as a QR code and scan it with your phone:
#   node bin/qr.mjs 'sgnl://linkdevice?uuid=...'
signal-cli link -n "Signal Automator"

# Terminal 1: the daemon, with the number that linking printed.
signal-cli -a +15551234567 daemon --http 127.0.0.1:7584

# Terminal 2: the server. Open http://127.0.0.1:7583.
SIGNAL_ACCOUNT=+15551234567 npm start
```

In PowerShell, set the variable first: `$env:SIGNAL_ACCOUNT = '+15551234567'; npm start`.
Stop the server with Ctrl+C. It saves its state and exits.

## Try it without a phone: mock mode

Mock mode replaces Signal with a pretend transport. Nothing leaves your computer:
"sent" messages only go to the log.

```sh
bin/start.sh --mock                                    # macOS, Linux
powershell -ExecutionPolicy Bypass -File .\powershell\Start-SignalAutomator.ps1 -Mock   # Windows
AUTOMATOR_TRANSPORT=mock npm start                     # by hand
```

- **Pretend contacts.** Your account is `+15550000000`. The contacts are Alice
  (`+15550000001`), Bob (`+15550000002`) and Carol (`+15550000003`), plus a group
  called "Test Group".
- **Pretend incoming messages.** Use any of these:
  - the **Simulate incoming** form on the **Keywords** tab;
  - `python -m signal_automator simulate --from Alice ping`;
  - `Invoke-AutomatorSimulation -From Alice -Message ping` in PowerShell;
  - `POST /api/simulate/incoming`.

  The example script `scripts/00-example-ping.js` answers `ping` with `pong`.
- **Separate data.** The start scripts keep mock-mode data in `data/mock/`, so your
  experiments don't mix with your real repeaters and rules. `AUTOMATOR_MOCK_DATA_DIR`
  changes that folder. `npm start` doesn't do this for you: set `AUTOMATOR_DATA_DIR`
  yourself.

Simulating an incoming message also works with a real account, which is handy for
testing rules. But then **the replies are really sent** to whoever you pretended the
message came from.

## Linking your Signal account

Linking makes signal-cli an additional device on your account, like Signal Desktop.
From then on it:

- receives your incoming messages;
- sees what you send from your other devices;
- can send messages as you.

Your phone remains the primary device, and you can unlink at any time.

1. Run `bin/link-device.sh` or `Link-SignalDevice.ps1`. It runs `signal-cli link` and
   shows the link as a QR code.
2. On your phone, open **Signal > Settings > Linked devices > Link new device** and scan
   the code. The code is valid for a few minutes. If it expires, run the script again.
3. When your phone confirms, the script saves your number as `SIGNAL_ACCOUNT` in the
   [config file](#the-config-file). The start scripts read it from there.

If the terminal code doesn't scan (small window, unusual font):

- use `--browser` / `-Browser` to open the same code as a local web page;
- or install `qrencode`, which the scripts use when it's present;
- or paste the printed `sgnl://` link into a QR code generator you trust.

Only ever scan a link code that your own computer made. Whoever gets you to scan
*their* code gets a linked device on your account.

The first start after linking can take a minute: signal-cli receives your contacts and
groups from the phone. If names are missing in the UI, press **Refresh contacts** on the
**Send** tab a little later. A group also becomes known once a message arrives in it.

To **unlink**, open **Linked devices** on your phone, tap the device and choose
**Unlink**. Signal also unlinks devices that haven't been online for about 30 days. To
link again, run the link script with `--force` / `-Force`.

## Using the web UI

Open <http://127.0.0.1:7583> (or `http://localhost:7583`). The header shows whether
signal-cli is connected. Every tab updates live.

| Tab | What you do there |
|---|---|
| **Dashboard** | Counts of messages, active repeaters, rules, scripts and contacts. Below them, the next scheduled sends with their countdowns, and recent messages. |
| **Send** | Pick a contact or group and send a message. Outgoing scripts run first, as they do for every send. **Refresh contacts** reloads the contact and group lists from signal-cli. |
| **Repeaters** | **New repeater** (see the fields below). Each card shows a live countdown, the next message, and **Run now**, **Edit**, **Delete** and an **Enabled** switch. |
| **Keywords** | **New rule** (see the fields below). Rules are checked top to bottom; use the arrows to reorder them. **Test rules** is a dry run that shows which rules match a text and what they'd send. **Simulate incoming** injects a pretend message. |
| **Scripts** | Edit the JavaScript files in `scripts/` in the browser. **New script** starts from a template. Each script has an on/off switch and shows its commands and its last error. **Reload all** picks up files you changed in another editor. There's also a cheat sheet for the `bot` API. |
| **Log** | The message log: incoming and outgoing messages, with their origin (manual, repeater, keyword, script, or sent from another device) and status. Below it, the system log with a level filter. Both can be searched. |

A new repeater takes:

- a name;
- one or more recipients;
- one or more messages, sent in rotation;
- the **pause between sends**, which is the countdown;
- an optional **random extra** delay;
- **max runs**, if it should stop after a number of sends.

A new rule takes:

- a **pattern** and a **match type**: contains, exact, starts with, regular expression,
  or whole word;
- case sensitivity;
- where to **listen**: all chats, direct chats only, or groups only;
- **only from senders**, to limit it to some senders;
- an **action**: reply, send to someone else, or run a script command;
- a **cooldown** per chat;
- whether to stop checking later rules once this one matches.

Reply texts are templates. They can use `{{body}}`, `{{sender}}`, `{{senderName}}`,
`{{match}}`, `{{time}}` and `{{date}}`, and regex groups `{{1}}` to `{{9}}`.

Repeaters keep counting down across restarts. If a send came due while the server was
stopped, it goes out once, soon after the next start. Missed sends are not repeated.

## Scripts

For logic that rules can't express, add a JavaScript file to `scripts/`, or create one
on the **Scripts** tab:

```js
// scripts/ping.js
export default function setup(bot) {
  bot.onIncoming(async (msg) => {
    if (msg.body.trim().toLowerCase() === 'ping') await msg.reply('pong');
  });
}
```

The `bot` API covers:

- incoming handlers;
- outgoing hooks, which can edit or cancel a message;
- commands, which keyword rules can call;
- sending;
- timers (`every`, `after`);
- per-script storage;
- logging.

[scripts/README.md](scripts/README.md) is the full reference, with recipes. It also
explains the example scripts in that folder:

- a ping responder;
- an away auto-reply;
- an outgoing signature;
- a countdown reminder.

Scripts run inside the server with full Node.js permissions. Only use scripts you wrote
or have read.

## Python client

`python/` is a Python 3.9+ package, standard library only, with a library and a command
line tool. You can run it straight from the checkout:

```sh
cd automator/python
python3 -m signal_automator status
python3 -m signal_automator contacts
python3 -m signal_automator send Alice "Running 10 minutes late"
python3 -m signal_automator send group:Family "Dinner is ready"
python3 -m signal_automator repeat add --to +15551234567 --every 1h30m -m "Drink water" --max-runs 5
python3 -m signal_automator keyword add --pattern price --match word --reply "Price list: https://example.com/prices"
python3 -m signal_automator keyword test "what is the price?"
python3 -m signal_automator simulate --from Bob "ping"
python3 -m signal_automator tail --incoming
```

You can also install it with `python3 -m pip install ./automator/python`, which gives
you a `signal-automator` command.

- **Recipients** can be written as:
  - a phone number (`+15551234567`);
  - a UUID;
  - a contact name;
  - `group:<name or id>`.
- **Durations** look like `30s`, `10m`, `2h`, `1d` or `1h30m`.
- **Output:** `--json` prints raw JSON instead of tables.

As a library:

```python
from signal_automator import AutomatorClient

bot = AutomatorClient()          # $AUTOMATOR_URL, else http://127.0.0.1:7583
bot.send('+15551234567', 'Hello from Python')
family = bot.find_recipient('group:Family')   # looks up a contact or group name
bot.create_repeater(family, ['Good morning!', 'Morning, all!'], every='1d')
bot.create_rule('price', reply='Our price list: https://example.com/prices', match='word')
for msg in bot.poll_messages(direction='incoming'):   # runs until Ctrl+C
    print(msg.get('senderName') or msg['sender'], msg['body'])
```

The library's methods take numbers, uuids, `group:<id>` or `{"kind", "id"}` dicts. To use
a contact or group name, look it up first with `find_recipient()`, as shown above. The
command line looks names up by itself.

`python/examples/` has three complete programs:

- `morning_greeting.py` sends at a time of day rather than at an interval;
- `message_log_csv.py` exports the message log;
- `sync_rules.py` keeps keyword rules in a JSON file.

Run the tests with `python3 -m unittest discover -s tests -v`, from `python/`.

## PowerShell

The Windows launcher scripts are described in the
[Windows quick start](#quick-start-windows). Two more scripts and a module work on any
system with PowerShell 5.1 or 7:

```powershell
# Send a message (a number, a contact name, or -Group with a group name)
.\powershell\Send-SignalMessage.ps1 -To Alice -Message 'The build is green'
Get-Content .\report.txt -Raw | .\powershell\Send-SignalMessage.ps1 -To +15551234567

# Call any endpoint
.\powershell\Invoke-Automator.ps1 /api/status
.\powershell\Invoke-Automator.ps1 /api/repeaters -Method POST -Body @{ name = 'Ping'; recipients = @(@{ kind = 'contact'; id = '+15551234567' }); messages = @('ping'); intervalSeconds = 3600 }

# The module: 34 commands for everything in the web UI
Import-Module .\powershell\SignalAutomator.psm1
Get-Command -Module SignalAutomator
New-AutomatorRepeater -To 'Family' -Group -Message 'Stand-up in 5 minutes' -Every 1d
New-AutomatorRule -Pattern 'status' -Match word -Reply 'All systems normal ({{time}})'
Get-AutomatorRepeater | Format-Table name, enabled, runCount, nextRunAt
Test-AutomatorRule -Message 'status please'
Watch-AutomatorMessage -Direction incoming
```

The module has `Get`, `New`, `Set`, `Enable`, `Disable` and `Remove` commands for
repeaters, rules and scripts. It also has:

| Command | What it does |
|---|---|
| `Send-AutomatorMessage` | Sends a message. |
| `Get-AutomatorMessage`, `Watch-AutomatorMessage` | Reads the message log, or follows it. |
| `Get-AutomatorContact`, `Get-AutomatorGroup`, `Update-AutomatorContact` | Lists, or refreshes, contacts and groups. |
| `Invoke-AutomatorRepeater` | The same as **Run now** in the web UI. |
| `Set-AutomatorRuleOrder` | Changes the order in which rules are checked. |
| `Test-AutomatorRule`, `Invoke-AutomatorSimulation` | Tries out rules and scripts. |
| `Get-AutomatorStatus`, `Get-AutomatorState` | Shows the connection, or the whole state. |
| `Invoke-AutomatorApi` | Calls any REST endpoint. |

Every command has help, for example `Get-Help New-AutomatorRule -Examples`. Commands
that change something support `-WhatIf`. Errors from the server come back as PowerShell
errors that include the server's message.

## Configuration

### The config file

The launcher scripts read settings from a config file, and the install and link scripts
write to it:

| System | Location |
|---|---|
| Windows | `%APPDATA%\SignalAutomator\config.env` |
| macOS, Linux | `~/.config/signal-automator/config.env`, or `$XDG_CONFIG_HOME/signal-automator/config.env` |

Set `SIGNAL_AUTOMATOR_CONFIG` to use another file. The format is the same on every
system:

```sh
# Lines are KEY=value. Lines starting with # are ignored.
SIGNAL_ACCOUNT=+15551234567
SIGNAL_CLI=/home/me/.local/share/signal-automator/signal-cli/0.13.12/signal-cli-0.13.12/bin/signal-cli
AUTOMATOR_PORT=7583
SIGNAL_CLI_DAEMON_ARGS='--ignore-stories'
```

- **Values:** one pair of surrounding quotes is removed. Nothing is expanded or
  executed.
- **Names:** only `AUTOMATOR_*`, `SIGNAL_*` and `JAVA_HOME` are accepted.
- **Precedence:** an environment variable with the same name wins over the file.
- **Who reads it:** the launcher scripts, which pass the settings on to signal-cli and
  the server. The server itself only reads environment variables, so the file doesn't
  apply when you run `npm start` yourself.

### Environment variables

Read by the server:

| Variable | Default | Meaning |
|---|---|---|
| `AUTOMATOR_PORT` | `7583` | Port of the web UI and the REST API. |
| `AUTOMATOR_HOST` | `127.0.0.1` | Address to listen on. Keep the default. See [Security](#security) before changing it. |
| `AUTOMATOR_TRANSPORT` | `signal-cli` | `signal-cli`, or `mock` for [mock mode](#try-it-without-a-phone-mock-mode). |
| `SIGNAL_CLI_URL` | `http://127.0.0.1:7584` | Where the signal-cli daemon's HTTP interface is. The start scripts also start the daemon on this address. |
| `SIGNAL_ACCOUNT` | *(none)* | Your number in international format, as saved by the link scripts. The start scripts need it to start the daemon. The server passes it to signal-cli when it's set. |
| `AUTOMATOR_DATA_DIR` | `automator/data` | Where `state.json` and the scripts' storage are kept. |
| `AUTOMATOR_SCRIPTS_DIR` | `automator/scripts` | The scripts folder. |
| `AUTOMATOR_WEB_DIST` | `automator/web/dist` | The built web UI. |
| `AUTOMATOR_DEBUG` | *(unset)* | Set to any value to log at debug level. |

Read by the launcher scripts:

| Variable | Default | Meaning |
|---|---|---|
| `SIGNAL_CLI` | *(searched)* | The signal-cli program; on Windows, `signal-cli.bat`. The install scripts save it. Otherwise the scripts search `PATH` and then their own download folder. |
| `SIGNAL_CLI_ARGS` | *(none)* | Extra global signal-cli options, placed before the command in every call. For example, `--config /path/to/signal-cli-data`. |
| `SIGNAL_CLI_DAEMON_ARGS` | `--ignore-attachments --ignore-stories` | Options added after `daemon --http ...`. Set it to an empty value to pass none. |
| `SIGNAL_CLI_START_TIMEOUT` | `120` | Seconds to wait for the daemon to answer. |
| `SIGNAL_CLI_RELEASES_API` | GitHub's API | The URL the install scripts use to find the latest signal-cli release. Point it at a mirror if needed. |
| `JAVA_HOME` | *(none)* | The Java installation to run signal-cli with. |
| `AUTOMATOR_MOCK_DATA_DIR` | `<data dir>/mock` | The data folder used in mock mode. |
| `SIGNAL_AUTOMATOR_CONFIG` | see above | The config file. |
| `NO_COLOR` | *(unset)* | Turns off colored output in the bash scripts. |

Read by the clients:

| Variable | Default | Meaning |
|---|---|---|
| `AUTOMATOR_URL` | `http://127.0.0.1:7583` | Where the Python client, the PowerShell module and the web dev server (`npm run dev`) find the server. Without it, they use `AUTOMATOR_HOST` and `AUTOMATOR_PORT`. |

Relative paths are resolved against the server's working directory:

- the `automator` folder when a start script launched it;
- `automator/server` when `npm start` did.

Absolute paths avoid any doubt.

### Files and logs

| What | Windows | macOS, Linux |
|---|---|---|
| Settings | `%APPDATA%\SignalAutomator\config.env` | `~/.config/signal-automator/config.env` |
| signal-cli, as downloaded by the install script | `%LOCALAPPDATA%\SignalAutomator\signal-cli\` | `~/.local/share/signal-automator/signal-cli/`. On macOS it's installed with Homebrew instead. |
| Logs and PID files of the start scripts | `%LOCALAPPDATA%\SignalAutomator\logs\` | `~/.local/state/signal-automator/` |
| Automator data: repeaters, rules, the last 500 messages | `automator\data\` (mock mode: `data\mock\`) | `automator/data/` (mock mode: `data/mock/`) |
| signal-cli's account data, including **your account keys** | `%USERPROFILE%\.local\share\signal-cli\` | `~/.local/share/signal-cli/` |

The start scripts write two logs, `daemon.log` and `server.log`. The logs of the
previous start are kept as `daemon.log.1` and `server.log.1`.

## Keeping it running, updating, developing

**Start at login.**

- **Windows:** in Task Scheduler, create a task that runs at log on, with this action:

  ```text
  powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\path\to\automator\powershell\Start-SignalAutomator.ps1 -NoBrowser
  ```

- **Linux with systemd:** create a user service. Run
  `loginctl enable-linger $USER` if it should keep running while you're logged out.

  ```ini
  # ~/.config/systemd/user/signal-automator.service
  # enable with: systemctl --user enable --now signal-automator
  [Unit]
  Description=Signal Automator

  [Service]
  ExecStart=/path/to/automator/bin/start.sh --foreground --no-browser
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

- **macOS:** add a login item or a launchd agent that runs
  `bin/start.sh --foreground --no-browser`.

**Keep the link alive.** Signal unlinks a device that hasn't been online for about 30
days, so don't leave the daemon stopped for longer than that.

**Update.** Pull the new code, run the install script again (it runs `npm install` and
`npm run build`), then stop and start. signal-cli needs updating too, every few months,
because old versions stop working as Signal changes:

- **macOS:** `brew upgrade signal-cli`.
- **Linux:** `bin/install.sh --force-signal-cli`.
- **Windows:** `Install-SignalAutomator.ps1 -ForceSignalCli`.

**Develop.** Run `npm run dev` to start two things:

- the server, which restarts when its files change;
- the Vite dev server on <http://localhost:5173>, which hot-reloads the UI and forwards
  API calls to the server (`AUTOMATOR_URL`, default `http://127.0.0.1:7583`).

Both stop together on Ctrl+C, on every platform. `AUTOMATOR_TRANSPORT=mock` works well
for UI work. Other commands:

- `npm test` runs the server and web UI tests;
- `npm run typecheck` checks the types;
- `npm run build` builds both.

The folder layout:

```text
automator/
  server/       Node.js server: transport (signal-cli, mock), engine, REST API, WebSocket
  web/          React web UI (Vite); built into web/dist
  shared/       TypeScript types shared by the server and the web UI
  scripts/      your scripts, plus examples and the scripting reference
  python/       Python client and CLI (standard library only)
  powershell/   Windows launchers, Send-SignalMessage.ps1, Invoke-Automator.ps1, SignalAutomator.psm1
  bin/          macOS/Linux launchers, and qr.mjs (offline QR codes for linking)
  docs/         rest-api.md
  data/         created at runtime: state.json, script-store/
```

The REST API and the WebSocket events are documented in
[docs/rest-api.md](docs/rest-api.md).

## Security

Signal Automator can do anything your Signal account can do, so treat access to it like
access to your unlocked phone.

- **Local access means full access.**
  - **No password.** The server and the signal-cli daemon listen only on `127.0.0.1`,
    so other computers can't reach them. Neither has a password or login, though.
  - **What a local program can do.** Any program on this computer that can open a
    connection to port 7583 can read your recent messages and send messages as you. The
    same goes for any other user on the computer. Through the scripts endpoint, such a
    program can also run code as you. The daemon's port, 7584, gives direct access to
    your account.
  - **Where not to run it.** Don't run the automator on a computer that people you don't
    trust can log in to.
- **Websites can't use it.** The server rejects requests whose `Host` or `Origin` isn't
  the local address. This blocks web pages you visit, including DNS rebinding tricks.
  - **403 errors.** Open the UI as `127.0.0.1` or `localhost`, not by the computer's
    name.
- **Don't expose it to the network.**
  - **Wildcard addresses.** `AUTOMATOR_HOST=0.0.0.0` (or `::`) makes the UI reachable
    from your whole network with no authentication, and turns the host check off.
  - **Other addresses.** Any other address you set is reachable by everything that can
    reach that address.
  - **Remote access.** If you need it, use an SSH tunnel:
    `ssh -L 7583:127.0.0.1:7583 your-computer`.
- **Scripts are code.**
  - **Full permissions.** Scripts run inside the server with full Node.js permissions.
    They can read your files, reach the internet and message anyone.
  - **Only trusted scripts.** Only run scripts you wrote or have read.
- **Protect signal-cli's data folder.** It holds your account keys (see
  [Files and logs](#files-and-logs)). With a copy, someone can read and send your
  messages until you unlink the device. If the computer or a backup of it is
  compromised, unlink the device on your phone.
- **Message text is stored unencrypted.** The last 500 messages are kept in
  `data/state.json`.
- **Link codes.** Only scan QR codes your own computer showed you
  ([details](#linking-your-signal-account)).
- **Be a good sender.**
  - **Consent.** Automated messages should go to people who expect them.
  - **Rate limits.** Signal rate-limits accounts that send a lot. See
    [Troubleshooting](#troubleshooting).

## Troubleshooting

Start with the logs:

- the terminal, or `server.log` and `daemon.log` (see [Files and logs](#files-and-logs));
- the **Log** tab.

**"running scripts is disabled on this system" (Windows).**
Use `powershell -ExecutionPolicy Bypass -File ...`, or see
[Quick start: Windows](#quick-start-windows).

**`node`, `npm` or `java` not found right after installing them.**
Open a new terminal window. Programs installed with winget or an installer are only
added to the `PATH` of new windows.

**"signal-cli needs Java 21 or newer", or `UnsupportedClassVersionError` in the daemon log.**
Install Java 21 or newer:

- Windows: `winget install EclipseAdoptium.Temurin.21.JRE`;
- Linux: `openjdk-21-jre-headless` or similar.

If several Java versions are installed, point `JAVA_HOME` at the right one in the config
file.

**The browser shows "Signal Automator web UI is not built".**
Run `npm run build` in the `automator` folder, or run the install script again.

**The browser or a client gets `403 forbidden host or origin`.**
Use `http://127.0.0.1:7583` or `http://localhost:7583`, not the computer's name or
network address. See [Security](#security).

**"already in use", `EADDRINUSE`, or the start script says the port is taken.**

- Another copy is probably running. Stop it with the stop script. If you started it with
  `npm start` elsewhere, press Ctrl+C there.
- Or use another port: `--port` / `-Port`, or `AUTOMATOR_PORT`.
- If the daemon's port is taken, set `SIGNAL_CLI_URL`, for example to
  `http://127.0.0.1:7590`.

**The UI header says signal-cli is disconnected or connecting.**

- Check that the daemon runs: `curl http://127.0.0.1:7584/api/v1/check` should answer
  with no error.
- Check `daemon.log`.
- Check that `SIGNAL_CLI_URL` matches the daemon's address.
- The server keeps retrying, up to every 30 seconds, and reconnects by itself.

**"User +... is not registered".**
The device is no longer linked. Either it was unlinked on the phone, or it was offline
for about 30 days. Link again with `bin/link-device.sh --force` or
`Link-SignalDevice.ps1 -Force`.

If signal-cli then says the user already exists, it still has data from the old link:

1. Stop the automator.
2. Run `signal-cli -a +15551234567 deleteLocalAccountData --ignore-registered`.
3. Link again.

**"Config file is in use by another instance".**
Only one signal-cli process at a time can use an account. Stop the daemon (the stop
script) before you run other `signal-cli` commands yourself, then start it again. Also
check that a second daemon isn't running.

**Contacts or groups are missing, or show only as numbers.**
Right after linking, the phone is still sending your contacts. Wait a minute, then press
**Refresh contacts** on the **Send** tab. A group also appears once a message arrives in
it.

**Sending fails with an "untrusted identity" error.**
The recipient's safety number changed, for example because they reinstalled Signal, and
signal-cli won't send until the new one is trusted.

1. Verify the new safety number on your phone.
2. Stop the daemon.
3. Run `signal-cli -a +YOUR_NUMBER trust -a +THEIR_NUMBER`.
4. Start again.

To trust every new safety number automatically, set
`SIGNAL_CLI_ARGS=--trust-new-identities always`. This is convenient, but it gives up the
protection that safety numbers provide.

**Sending fails with a rate limit or "proof required" error.**
Signal limits how fast an account can send.

- Space your sends out: a longer pause, a random extra delay, fewer recipients per
  repeater.
- For "proof required", signal-cli's error message explains how to solve the challenge
  (the `submitRateLimitChallenge` command).

**It worked for months, and now sending or receiving fails.**
Update signal-cli (see [updating](#keeping-it-running-updating-developing)). Signal
retires old client versions.

**The daemon stops at once with `UnsatisfiedLinkError` or `signal_jni` (ARM Linux, Raspberry Pi).**
signal-cli's Java build includes libsignal's native library only for some platforms.
Either:

- follow signal-cli's wiki page "Provide native lib for libsignal";
- or build the library from this repository with `java/build_jni.sh desktop`. The
  libsignal version must match the `libsignal-client-*.jar` in signal-cli's `lib`
  folder.

**The QR code doesn't scan.**

- Make the terminal window bigger or the font smaller.
- Or use `--browser` / `-Browser` to show the code in your browser.
- Or install `qrencode`.

The code expires after a few minutes: run the link script again for a fresh one.

**Stopping on Windows.**
`Stop-SignalAutomator.ps1` ends the processes at once, because Windows can't ask a
program without a window to exit. Nothing is lost: the server saves every change within
a quarter of a second. For a gentle shutdown, run `npm start` in a console window and
press Ctrl+C.

**Messages from before the link don't show up.**
That's expected. A linked device only receives messages sent after it was linked.

## About this folder

This folder is an addition to a fork of [signalapp/libsignal](https://github.com/signalapp/libsignal).
It doesn't modify the Rust library in the rest of this repository, or its Java, Swift
and Node bindings, and it doesn't depend on them. It talks to Signal only through
signal-cli, which uses the published libsignal-client package. Signal Automator isn't
affiliated with Signal Messenger LLC, and signal-cli is an unofficial client.
