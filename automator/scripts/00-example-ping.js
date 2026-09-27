// Example script: a quick "is the automator alive?" check.
//
// Every .js file in this folder is loaded when the server starts, so this one is
// active by default. It is deliberately harmless:
//   - When someone sends you exactly "ping" in a 1:1 chat, it answers "pong"
//     (never in groups).
//   - It registers a "time" command. Commands do nothing on their own: they run
//     only when a keyword rule points at them, for example
//       python -m signal_automator keyword add --pattern "what time is it" --command time
//     or in the web UI: Keywords -> New rule -> action "Script command", command name: time.
//
// Try it without a phone: start in mock mode and use "Simulate incoming" in the
// Keywords tab (from: +15550000001, body: ping).
// Don't want it? Switch it off in the Scripts tab or delete the file.

/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  bot.onIncoming(async (msg) => {
    if (msg.isGroup) return;
    if (msg.body.trim().toLowerCase() !== 'ping') return;
    await msg.reply('pong');
  });

  bot.command('time', async (msg) => {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    await msg.reply(`It is ${time} on ${date}.`);
  });
}
