/** Starter source for a new user script. */
export const STARTER_SCRIPT = [
  "/** @param {import('../server/src/contracts').Bot} bot */",
  'export default function setup(bot) {',
  '  // React to every incoming message.',
  '  bot.onIncoming(async (msg) => {',
  "    if (msg.body.trim().toLowerCase() === 'ping') {",
  "      await msg.reply('pong');",
  '    }',
  '  });',
  '',
  "  // Handler for keyword rules whose action is { type: 'script', command: 'echo' }.",
  "  bot.command('echo', async (msg, match) => {",
  "    const count = (bot.store.get('echoes') ?? 0) + 1;",
  "    bot.store.set('echoes', count);",
  '    await msg.reply(`Echo #${count}: ${msg.body}`);',
  '  });',
  '',
  '  // Runs every hour while this script is enabled.',
  '  bot.every(3600, () => {',
  "    bot.log('still running; echoes so far:', bot.store.get('echoes') ?? 0);",
  '  });',
  '}',
  '',
].join('\n');

export interface CheatEntry {
  sig: string;
  doc: string;
}

/** Condensed from the Bot interface in server/src/contracts.ts. */
export const BOT_API: { title: string; entries: CheatEntry[] }[] = [
  {
    title: 'Script shape',
    entries: [
      { sig: 'export default function setup(bot) { … }', doc: 'ES module; setup may be async. Everything registered is torn down on disable, edit or reload.' },
    ],
  },
  {
    title: 'Events',
    entries: [
      { sig: 'bot.onIncoming(async (msg) => { … })', doc: 'Called for every incoming message.' },
      { sig: 'bot.onOutgoing((out) => { … })', doc: 'Hook before sends. Return a string to replace the body, false to cancel, nothing to leave it.' },
      { sig: 'bot.command(name, async (msg, match) => { … })', doc: 'Handler for keyword rules with a script action. match is the regex match or [body].' },
    ],
  },
  {
    title: 'Incoming msg',
    entries: [
      { sig: 'msg.body · msg.sender · msg.senderName', doc: 'Text and who sent it (number or uuid).' },
      { sig: 'msg.isGroup · msg.conversation · msg.message', doc: 'Group flag, the Recipient to answer in, the full SignalMessage.' },
      { sig: 'await msg.reply(text)', doc: 'Reply in the same conversation.' },
    ],
  },
  {
    title: 'Outgoing hook ctx',
    entries: [
      { sig: 'out.body · out.to · out.origin · out.message', doc: "origin: 'manual' | 'repeater' | 'keyword' | 'script' | 'external'." },
      { sig: 'out.cancellable', doc: "False for 'external' (already sent from another device); return values are ignored." },
    ],
  },
  {
    title: 'Actions & timers',
    entries: [
      { sig: "await bot.send(to, text)", doc: 'to: a Recipient, a contact number/uuid, or "group:<groupId>".' },
      { sig: 'const stop = bot.every(seconds, fn)', doc: 'Repeat until the script unloads. Returns a cancel function.' },
      { sig: 'const cancel = bot.after(seconds, fn)', doc: 'Run once later. Returns a cancel function.' },
      { sig: 'await bot.sleep(seconds)', doc: 'Pause; rejects if the script unloads first.' },
    ],
  },
  {
    title: 'Data & logging',
    entries: [
      { sig: 'bot.contacts() · bot.groups()', doc: 'Current contact and group lists.' },
      { sig: 'bot.store.get(key) · set(key, value) · delete(key)', doc: 'Persistent per-script key/value storage (JSON values).' },
      { sig: 'bot.log(...args) · bot.name', doc: 'Write to the system log under script:<name>; the script file name.' },
    ],
  },
];
