# Scripting library reference

User scripts add behavior that keyword rules and repeaters can't express: conditions,
state, calling other services, rewriting outgoing messages. A script is a plain
JavaScript ES module in this folder. It exports a `setup(bot)` function, and the server
calls it with a `bot` object:

```js
/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  bot.onIncoming(async (msg) => {
    if (msg.body.trim().toLowerCase() === 'ping') await msg.reply('pong');
  });
}
```

The JSDoc line is optional. It gives editors such as VS Code autocompletion and type
hints from [`server/src/contracts.ts`](../server/src/contracts.ts), the source of truth
for everything below.

> **Scripts run inside the server with full Node.js permissions.** A script can read
> and write your files, open network connections and send Signal messages as you. Only
> run scripts you wrote or have read and trust.

Contents:

- [Files, loading and reloading](#files-loading-and-reloading)
- [The `bot` object](#the-bot-object)
- [Incoming messages: `IncomingContext`](#incoming-messages-incomingcontext)
- [Outgoing hooks: `OutgoingContext`](#outgoing-hooks-outgoingcontext)
- [Commands and keyword rules](#commands-and-keyword-rules)
- [Keyword rule reference and templates](#keyword-rule-reference-and-templates)
- [Timers](#timers)
- [Persistent storage](#persistent-storage)
- [Errors and logging](#errors-and-logging)
- [Trying scripts safely](#trying-scripts-safely)
- [Recipes](#recipes)
- [The example scripts in this folder](#the-example-scripts-in-this-folder)

## Files, loading and reloading

- **Which files are scripts.** Every top-level `*.js` or `*.mjs` file in this folder
  whose name matches `[A-Za-z0-9._-]+` is a script. Files starting with `_` or `.` are
  skipped: use `_`-names for helper modules your scripts import (`import { x } from
  './_utils.js'`). Subfolders, `README.md` and `package.json` are ignored. The folder
  can be moved with the `AUTOMATOR_SCRIPTS_DIR` environment variable.
- **Enabled by default.** A script that is present is enabled unless you switch it off
  in the **Scripts** tab. The on/off choice is saved in the server's `state.json`, so it
  survives restarts. Each script's command names and last error are shown in that tab too.
- **Load order.** Scripts load alphabetically by file name, in plain character-code
  order (digits, then uppercase, then lowercase). That order is the order in which
  `onIncoming` handlers and `onOutgoing` hooks run. Prefix names with numbers
  (`10-...`, `20-...`) to control it.
- **ES modules.** Scripts are always loaded as ES modules. They can `import` Node
  built-ins (`import fs from 'node:fs/promises'`), JSON files, relative helper
  modules, and npm packages. To add a package, run `npm install <package>` inside this
  folder; the `package.json` here exists for that and to mark the folder as ES modules
  for editors. The global `fetch` is available (Node 20+).
- **`setup(bot)`** may be `async`. Register handlers, commands and timers in it and
  return. The server waits up to 10 seconds for `setup`; if it's still running after that
  (for example an endless loop), the script counts as loaded and a warning is logged.
  For background loops use `bot.every`.
- **Reloading.** A script is torn down and loaded again when you:
  - save it in the **Scripts** tab (`PUT /api/scripts/:name`),
  - switch it off and on again,
  - press **Reload all** in the Scripts tab (`POST /api/scripts/reload`, or
    `python -m signal_automator script reload`), which also picks up new or deleted
    files, or
  - restart the server.

  **The server doesn't watch the folder.** If you edit a file with your own editor,
  press **Reload all** afterwards.
- **What a reload does.** Everything the old copy registered is removed: incoming
  handlers, outgoing hooks, commands, `every`/`after` timers, and pending `sleep`s,
  which reject. The module and its relative helper modules are then evaluated again,
  so module-level variables start fresh. Anything that must survive a reload or
  restart belongs in [`bot.store`](#persistent-storage). Each script gets its own
  copies of the helper modules, so two scripts can't share state through a helper;
  use the store or the REST API instead.

## The `bot` object

| Member | Description |
| --- | --- |
| `bot.name` | The script's file name, e.g. `away-autoreply.js`. |
| `bot.onIncoming(handler)` | Calls `handler(msg)` for every message someone sends you, in 1:1 chats and groups. See [IncomingContext](#incoming-messages-incomingcontext). |
| `bot.onOutgoing(hook)` | Calls `hook(ctx)` before every message the automator sends, and after every message you send from another device. The hook can change or cancel the message. See [OutgoingContext](#outgoing-hooks-outgoingcontext). |
| `bot.command(name, handler)` | Registers `handler(msg, match)` for keyword rules whose action is "Script command" `name`. See [Commands](#commands-and-keyword-rules). |
| `bot.send(to, text)` | Sends `text` as you. `to` is a contact id (`'+15551234567'` or an ACI uuid), `'group:<groupId>'`, or a `{ kind: 'contact' \| 'group', id }` object. Resolves with the logged `SignalMessage`. Rejects when sending fails, when an outgoing hook cancels the message, or when the script has been unloaded. |
| `bot.every(seconds, fn)` | Runs `fn` every `seconds` (must be > 0) until the script unloads. The first run is after `seconds`, not immediately. Returns a function that cancels it. |
| `bot.after(seconds, fn)` | Runs `fn` once after `seconds` (>= 0). Returns a cancel function. Delays longer than 24.8 days work. |
| `bot.sleep(seconds)` | A promise that resolves after `seconds`. It rejects if the script unloads first. |
| `bot.contacts()` | Copy of the known contacts: `[{ id, number?, uuid?, name? }]`. |
| `bot.groups()` | Copy of the known groups: `[{ id, name, memberCount? }]`. |
| `bot.store.get(key)` / `.set(key, value)` / `.delete(key)` | Persistent per-script key/value storage. See [Persistent storage](#persistent-storage). |
| `bot.log(...args)` | Writes one info line to the **Log** tab and the server console, under the source `script:<name>`. Objects are pretty-printed. |

Contacts and groups are reloaded from signal-cli when it connects, and when you press
**Refresh contacts** in the Send tab. Use them to find a group id by name:

```js
const family = bot.groups().find((g) => g.name === 'Family');
if (family) await bot.send(`group:${family.id}`, 'Dinner is ready!');
```

## Incoming messages: `IncomingContext`

`onIncoming` handlers and command handlers receive a context `msg`:

| Field | Description |
| --- | --- |
| `msg.body` | The message text. |
| `msg.sender` | Who sent it: their number, or their ACI uuid when the number is hidden. |
| `msg.senderName` | Their name, when known (profile or contact name). |
| `msg.isGroup` | `true` for group messages. |
| `msg.conversation` | Where to answer: the group for group messages, otherwise the sender. A recipient object, usable with `bot.send`. |
| `msg.message` | The full logged `SignalMessage` (`id`, `timestamp`, `peer`, ...). |
| `msg.reply(text)` | Sends `text` to `msg.conversation`. Same promise behavior as `bot.send`. |

Order of processing for each incoming message:

1. Keyword rules are checked in the order shown in the Keywords tab. Each matching rule's
   action is run and awaited. A rule with "stop processing" skips the rules after it.
2. Then **every** loaded script's `onIncoming` handlers run, one after another in
   script load order, **whether or not a rule matched**. "Stop processing" doesn't
   affect scripts.

Each handler gets up to 10 seconds. After that the next one starts, and the slow one
keeps running in the background. For a delayed reply, use `bot.after` instead of
waiting inside the handler.

Only messages that contain text reach scripts and rules. Reactions, receipts,
attachments without a caption and typing indicators don't.
Messages you send yourself from your phone or Signal Desktop are **not** incoming
messages. They reach `onOutgoing` hooks with origin `'external'`.

```js
bot.onIncoming(async (msg) => {
  if (msg.isGroup) return;                       // 1:1 chats only
  if (/\bthank(s| you)\b/i.test(msg.body)) {
    await msg.reply(`You're welcome, ${msg.senderName ?? 'friend'}!`);
  }
});
```

## Outgoing hooks: `OutgoingContext`

`bot.onOutgoing(hook)` sees every message on its way out: manual sends from the UI or
API, repeaters, keyword replies, and other scripts' `bot.send`/`msg.reply`. Hooks also
see messages you sent from your own phone or Signal Desktop, after the fact.

| Field | Description |
| --- | --- |
| `ctx.body` | The text as it stands now, after earlier hooks' changes. |
| `ctx.to` | The recipient object (contact or group). |
| `ctx.origin` | Why the message is being sent: `'manual'` (UI/API), `'repeater'`, `'keyword'`, `'script'`, or `'external'` (you, on another device). |
| `ctx.cancellable` | `false` for `'external'`: that message is already delivered and the hook's return value is ignored. |
| `ctx.message` | The draft `SignalMessage`, including `originRef` (the repeater id, rule id or script name that produced it). |

**What a hook returns:**

| Return value | Effect |
| --- | --- |
| nothing (`undefined`) | The message goes out unchanged. |
| a string | Replaces the text. Hooks in later scripts see the new text. |
| `''` (empty or only whitespace) | Cancels the message. |
| `false` | Cancels the message. `bot.send`/`msg.reply` reject with a "cancelled" error, `POST /api/send` answers 409, and repeaters and rules log it. |

Hooks run in script load order and may be `async`. A hook that throws is skipped for
that message (the error is recorded) and the message goes on. A hook that takes more
than 10 seconds is also skipped.

Sending from inside a hook (`bot.send` in `onOutgoing`) is allowed, but that new
message passes through **all** hooks again, including yours. Guard against loops: react
only to specific origins or recipients. Nesting deeper than 3 levels fails with "send
recursion limit reached". The nested message is sent before the one that triggered it.

```js
// Expand shortcuts in everything the automator sends, but not in what you type yourself.
bot.onOutgoing((ctx) => {
  if (!ctx.cancellable) return;
  return ctx.body.replace(/\bbrb\b/gi, 'be right back');
});
```

## Commands and keyword rules

`bot.command(name, handler)` registers a handler that **only** runs when a keyword rule
has the action **Script command** with that name
(`{ type: 'script', command: 'name' }` in the API). No message prefix such as
`!name` triggers it by itself: the rule decides which messages reach the command,
from whom, where, and how often.

The handler gets `(msg, match)`:

- `msg` is the [IncomingContext](#incoming-messages-incomingcontext); `msg.reply` answers
  where the message came from.
- `match` is the regular-expression match array for **Regular expression** and
  **Whole word** rules: `match[0]` is the matched text, and `match[1]`, `match[2]` and
  so on are capture groups (`''` when a group did not take part). For the other match
  types it is `[body]`.

```js
// Rule: pattern ^weather\s+(.+)$, match type "Regular expression", action "Script command": weather
bot.command('weather', async (msg, match) => {
  const city = match[1] ?? msg.body;             // match[1] when the rule is a regex
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
  await msg.reply(res.ok ? (await res.text()).trim() : `No weather for ${city} right now.`);
});
```

Create the rule in the **Keywords** tab (New rule, "Then": Script command) or from a
terminal:

```sh
python -m signal_automator keyword add --pattern '^weather\s+(.+)$' --match regex --command weather
```

If two scripts register the same command name, the one that loads first wins. A rule
pointing at a command that no loaded script provides logs a warning when it matches.

## Keyword rule reference and templates

Rules need no script at all for fixed replies. Each rule has:

| Setting | Meaning |
| --- | --- |
| Pattern | The text to look for. |
| Match type | **Contains** (anywhere in the message), **Exact message** (the whole message, ignoring surrounding spaces), **Starts with** (ignoring leading spaces), **Whole word** (not part of a longer word; `c++` and `?help` work), **Regular expression** (JavaScript syntax). |
| Case sensitive | Off by default. For regexes, off means the `i` flag. |
| Listen in | All chats, direct (1:1) chats only, or groups only. |
| Only from senders | Numbers/uuids allowed to trigger it. Empty means anyone. |
| Cooldown | Minimum seconds between two triggers **in the same conversation**. |
| Stop processing | Don't check later rules after this one matches. |
| Then | **Reply in chat**, **Send to someone** (a fixed contact or group), or **Script command**. |

Reply and send texts are templates:

| Placeholder | Replaced with |
| --- | --- |
| `{{body}}` | The whole incoming message. |
| `{{sender}}` | The sender's number (or uuid). |
| `{{senderName}}` | The sender's name, or their number when no name is known. |
| `{{match}}` | The part of the message that matched the pattern. |
| `{{time}}` / `{{date}}` | The server's local time `HH:MM` / date `YYYY-MM-DD`. |
| `{{1}}` ... `{{9}}` | Regular-expression capture groups (empty when absent). |

Unknown placeholders are left as they are. Some templates:

| Goal | Pattern / match type | Then |
| --- | --- | --- |
| Opening hours | `opening hours` / Contains, cooldown 3600 | Reply: `Hi {{senderName}}! We're open Mon-Fri 9:00-17:00.` |
| Forward urgent messages to your group | `urgent` / Whole word | Send to `group:<id>`: `{{senderName}} ({{sender}}) wrote at {{time}}: {{body}}` |
| Order lookup | `^order\s+#?(\d+)$` / Regular expression | Reply: `Thanks! Looking up order {{1}}.` |
| Hand off to a script | `remind` / Starts with | Script command: `remind` |

Try rules without sending anything with **Test rules** in the Keywords tab,
`POST /api/rules/test`, or `python -m signal_automator keyword test "some text"`.

## Timers

```js
const stop = bot.every(15 * 60, async () => {    // every 15 minutes, first run in 15 minutes
  bot.log('still here');
});
bot.after(30, () => bot.send('+15551234567', 'Sent 30 seconds after the script loaded'));
bot.after(3600, stop);                           // cancel the `every` after an hour

bot.onIncoming(async (msg) => {
  if (msg.body !== 'slow') return;
  await bot.sleep(2);                            // pause this handler only
  await msg.reply('...done');
});
```

- All timers stop when the script unloads. A pending `sleep` then rejects. That ends
  the waiting handler quietly and is not recorded as an error.
- `every` doesn't wait for an `async` callback to finish. If a run can take longer than
  the interval, runs overlap, so guard with a flag.
- Timers don't survive restarts. To schedule something far ahead, save the due time in
  `bot.store` and re-arm it in `setup`, as `countdown-reminder.js` does.
- To act at a time of day, check the clock from a short `every`:

```js
bot.every(60, async () => {
  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() === 8 && bot.store.get('lastGreeting') !== today) {
    bot.store.set('lastGreeting', today);
    await bot.send('group:<groupId>', 'Good morning!');
  }
});
```

## Persistent storage

`bot.store` is a small key/value store per script. It is kept across reloads, restarts,
and even deleting and re-adding the script. It lives in
`<data dir>/script-store/<script file name>.json`: with the default data dir that's
`automator/data/script-store/away-autoreply.js.json`, and `AUTOMATOR_DATA_DIR` moves it.

- Values must be JSON-serializable. `Date`s become strings, `set(key, undefined)`
  deletes the key, and something that can't be serialized throws.
- `get` returns a **copy**. After changing an object or array, `set` it again:

  ```js
  const seen = bot.store.get('seen') ?? {};
  seen[msg.sender] = Date.now();
  bot.store.set('seen', seen);                   // without this the change is lost
  ```

- Writes go straight to disk, which suits small data: settings, a few hundred
  entries. Each script has its own file, and scripts can't read each other's stores.

## Errors and logging

- An error thrown by (or a promise rejected in) a handler, hook, command or timer
  callback is written to the **Log** tab and the server console at error level with its
  stack trace, under `script:<name>`. It's also shown next to the script in the
  **Scripts** tab. The script **stays loaded** and its other handlers keep working.
  The error display clears on the next successful load.
- If `setup` throws, or the file has a syntax error or no default export, the script is
  **not loaded**. The Scripts tab shows the error, and nothing it registered stays
  active. Fix it and save (or **Reload all**).
- Stack traces show your file's path followed by `?automator-script=...`. The line
  numbers are those of your file.
- `bot.send` and `msg.reply` failures (Signal unreachable, hook cancelled) reject the
  promise and are also logged by the server. An un-awaited send that fails can't crash
  anything.
- Use `bot.log(...)` for your own diagnostics. For warnings or errors, `console.warn`
  and `console.error` print to the server console only, not to the Log tab.

## Trying scripts safely

1. Start the automator in **mock mode**: `bin/start.sh --mock` (macOS/Linux) or
   `powershell\Start-SignalAutomator.ps1 -Mock` (Windows). Nothing is sent to Signal,
   and the fake contacts are Alice `+15550000001`, Bob `+15550000002` and Carol
   `+15550000003`, plus one group.
2. Inject messages with **Simulate incoming** in the Keywords tab, or:

   ```sh
   python -m signal_automator simulate --from +15550000001 ping
   python -m signal_automator tail            # watch what the automator sends back
   ```

3. With a real account, simulated messages are processed the same way, and **replies
   are really sent** to the `from` number (or group). Simulate from your own number
   or from a number that isn't a real contact.

Messages with origin `'external'` (your own phone) can't be simulated through the
API. Test those parts with the real app, in your Note to Self chat.

## Recipes

**Reply once per person per day**

```js
bot.onIncoming(async (msg) => {
  if (msg.isGroup) return;
  const today = new Date().toDateString();
  const greeted = bot.store.get('greeted') ?? {};
  if (greeted[msg.sender] === today) return;
  greeted[msg.sender] = today;
  bot.store.set('greeted', greeted);
  await msg.reply('Hi! This is an automated hello. I will answer properly soon.');
});
```

**Forward a keyword from any group to yourself**

```js
const ME = '+15551234567';                        // your own number: goes to Note to Self
bot.onIncoming(async (msg) => {
  if (msg.isGroup && /\b(help|urgent)\b/i.test(msg.body)) {
    const group = bot.groups().find((g) => g.id === msg.conversation.id);
    await bot.send(ME, `${msg.senderName ?? msg.sender} in ${group?.name ?? 'a group'}: ${msg.body}`);
  }
});
```

Messages sent to your own number show up in your Note to Self chat. They usually arrive
without a notification, because to Signal they come from your own account.

**Control a script from your phone** (see `away-autoreply.js` for a complete version)

```js
bot.onOutgoing(async (ctx) => {
  if (ctx.origin !== 'external') return;         // only what you typed yourself
  if (ctx.body.trim() === '!quiet') {
    bot.store.set('quiet', true);
    await bot.send(ctx.to, '[automator] quiet mode on');
  }
});
```

Type these commands in your Note to Self chat: they are real messages, and anyone in
the chat you type them into sees them.

**Cancel messages outside office hours**

```js
bot.onOutgoing((ctx) => {
  const hour = new Date().getHours();
  if (ctx.cancellable && ctx.origin === 'repeater' && (hour < 8 || hour >= 20)) {
    bot.log(`held back a repeater message to ${ctx.to.id} at night`);
    return false;
  }
});
```

**Share code between scripts with a helper module**

```js
// _format.js (not loaded as a script because of the leading underscore)
export const shout = (text) => text.toUpperCase() + '!';

// loud.js
import { shout } from './_format.js';
/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  bot.command('shout', (msg) => msg.reply(shout(msg.body.replace(/^shout\s*/i, ''))));
}
```

**Call a local program or web service**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

bot.command('uptime', async (msg) => {
  const { stdout } = await run('uptime');        // runs on the automator's computer
  await msg.reply(stdout.trim());
});
```

Restrict such commands with the rule's "Only from senders" setting.

## The example scripts in this folder

| File | What it shows | Active by default? |
| --- | --- | --- |
| `00-example-ping.js` | `onIncoming`, `msg.reply`, `bot.command` | Answers "ping" with "pong" in 1:1 chats; the `time` command needs a rule. |
| `away-autoreply.js` | `onOutgoing` with origin `'external'` as a remote control, `bot.store`, per-sender rate limiting | No: send `!away on` from your phone (Note to Self) to start it. |
| `outgoing-signature.js` | Hook return values: replace text, cancel (`false`), `ctx.cancellable` | Cancels messages containing `DO-NOT-SEND`. The repeater signature is off until you set `SIGNATURE`. |
| `countdown-reminder.js` | `bot.after`, `bot.every`, `bot.sleep`, commands with arguments, re-arming timers from `bot.store` | No: needs keyword rules for its `remind` and `countdown` commands. |

Switch off any of them in the Scripts tab, or delete the file. They are examples, and
nothing depends on them.
