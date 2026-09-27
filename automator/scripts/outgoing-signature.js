// Outgoing hooks: look at (and change or stop) every message before it is sent.
//
// 1. Safety net: a message containing DO-NOT-SEND is cancelled. Handy while you
//    draft a repeater or a keyword reply: keep DO-NOT-SEND in the text until it
//    is ready. A manual send from the UI or API is refused with 409 (cancelled).
// 2. Signature: appends SIGNATURE to messages sent by repeaters, and only those
//    (not your manual sends, keyword replies or other scripts). It is OFF until
//    you put some text in SIGNATURE below, e.g. '\n\n-- sent automatically'.
//
// Like every script in this folder it is enabled by default. To switch it off,
// use its toggle in the Scripts tab of the web UI, or run
//   python -m signal_automator script disable outgoing-signature.js
//
// Hook return values: a string replaces the text, false cancels the message,
// nothing leaves it unchanged. Messages you sent from your phone or Signal
// Desktop also pass through here (origin 'external'), but they are already
// delivered: ctx.cancellable is false and the return value is ignored.

const SIGNATURE = ''; // e.g. '\n\n-- sent automatically'
const MARKER = 'DO-NOT-SEND';

/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  bot.onOutgoing((ctx) => {
    const to = ctx.to.kind === 'group' ? `group ${ctx.to.id}` : ctx.to.id;

    if (ctx.body.includes(MARKER)) {
      if (ctx.cancellable) {
        bot.log(`cancelled a ${ctx.origin} message to ${to}: it contains ${MARKER}`);
        return false;
      }
      bot.log(`a message containing ${MARKER} was sent to ${to} from another device; it was already delivered`);
      return;
    }

    if (SIGNATURE && ctx.origin === 'repeater' && !ctx.body.endsWith(SIGNATURE)) {
      return ctx.body + SIGNATURE;
    }
  });
}
