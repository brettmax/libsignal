// Away auto-reply, switched on and off from your own phone.
//
// Send these from any of YOUR devices (phone, Signal Desktop), ideally in your
// "Note to Self" chat, because the command is a real message: typed into a chat
// with a friend, the friend sees it too.
//   !away on                       turn the auto-reply on (default text)
//   !away on Back on Monday.       turn it on with your own text
//   !away off                      turn it off
//   !away                          show the current state
// The automator confirms in the same chat.
//
// While away is on, the first message from each person in a 1:1 chat gets one
// auto-reply, then that person gets no further auto-reply for an hour. Groups
// are ignored. Nobody else can switch it: the commands are only read from
// messages you sent yourself (origin 'external').
//
// Does nothing until you send "!away on". State is kept in bot.store, so it
// survives restarts (file: <data dir>/script-store/away-autoreply.js.json).

const DEFAULT_TEXT = "Hi! I'm away at the moment and will get back to you later. (automatic reply)";
const QUIET_MS = 60 * 60 * 1000; // one auto-reply per person per hour
const COMMAND = /^!away\b\s*(?:(on|off)\b)?\s*([\s\S]*)$/i;

/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  // Commands: messages you typed on another device arrive here as 'external'.
  bot.onOutgoing(async (ctx) => {
    if (ctx.origin !== 'external') return;
    const m = COMMAND.exec(ctx.body.trim());
    if (!m) return;
    const [, onOff, text] = m;

    let answer;
    if (onOff && onOff.toLowerCase() === 'on') {
      bot.store.set('away', true);
      bot.store.set('text', text.trim() || DEFAULT_TEXT);
      bot.store.delete('repliedAt'); // everyone gets a fresh auto-reply
      answer = `Away mode is ON. Auto-reply: "${bot.store.get('text')}"`;
    } else if (onOff) {
      bot.store.set('away', false);
      answer = 'Away mode is OFF.';
    } else {
      const on = bot.store.get('away') === true;
      answer = on
        ? `Away mode is ON. Auto-reply: "${bot.store.get('text') ?? DEFAULT_TEXT}"`
        : 'Away mode is OFF. Send "!away on" (optionally followed by your own text) to turn it on.';
    }
    bot.log(answer);
    // Answer in the chat where you typed the command (Note to Self, usually).
    await bot.send(ctx.to, `[automator] ${answer}`);
  });

  // Auto-replies.
  bot.onIncoming(async (msg) => {
    if (bot.store.get('away') !== true) return;
    if (msg.isGroup) return;

    const now = Date.now();
    /** @type {Record<string, number>} */
    const repliedAt = bot.store.get('repliedAt') ?? {};
    if (now - (repliedAt[msg.sender] ?? 0) < QUIET_MS) return;

    // Forget people we answered more than an hour ago, so the store stays small.
    for (const [sender, at] of Object.entries(repliedAt)) {
      if (now - at >= QUIET_MS) delete repliedAt[sender];
    }
    repliedAt[msg.sender] = now;
    bot.store.set('repliedAt', repliedAt); // get() returns a copy: save the change

    await msg.reply(bot.store.get('text') ?? DEFAULT_TEXT);
  });
}
