// Countdown reminders: "remind 10 take the pizza out" and, ten minutes later,
// "Reminder: take the pizza out" comes back in the same chat.
//
// Shows the timer helpers:
//   bot.after(seconds, fn)  a one-shot timer per reminder
//   bot.every(seconds, fn)  a once-a-minute countdown of pending reminders in the log
//   bot.sleep(seconds)      the pauses in the "countdown" command (3, 2, 1, Go!)
// and bot.store, which keeps pending reminders across reloads and restarts.
//
// Does nothing until keyword rules send messages to its commands, e.g.
//   python -m signal_automator keyword add --pattern remind --match startsWith --command remind --scope direct
//   python -m signal_automator keyword add --pattern countdown --match startsWith --command countdown --scope direct
// (web UI: Keywords -> New rule -> action "Script command"). Anyone those
// rules match can make your account send reminders, so consider adding
// --from <their number> to limit who may use them.
//
//   remind 10 take the pizza out   minutes by default; units work too: 90s, 2h, 1.5h, 1d
//   remind                         list the pending reminders for this chat
//   remind cancel                  cancel them
//   countdown 5                    sends 5, 4, 3, 2, 1, Go! one second apart (at most 10)
//
// Reminders go back to the chat they were requested in (for a group, the group).

const MAX_SECONDS = 7 * 24 * 3600;
/** @type {Record<string, number>} */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
// "<number><optional unit> <text>"; the unit must be followed by a space, so
// "remind 10 dishes" is 10 minutes of "dishes", not 10 days.
const REMIND = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)?\s+([\s\S]+)$/i;

/**
 * 3725000 -> "1h 2m", 65000 -> "1m 5s"
 * @param {number} ms
 */
function formatLeft(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const parts = [];
  for (const [unit, size] of Object.entries(UNIT_SECONDS).reverse()) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)}${unit}`);
      s %= size;
    }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

/** @param {import('../server/src/contracts').Bot} bot */
export default function setup(bot) {
  /** @typedef {{ id: string, to: import('../server/src/contracts').IncomingContext['conversation'], text: string, dueAt: number }} Reminder */

  /** @returns {Reminder[]} */
  const load = () => bot.store.get('reminders') ?? [];
  /** @param {Reminder[]} list */
  const save = (list) => bot.store.set('reminders', list);
  /** @param {Reminder['to']} a @param {Reminder['to']} b */
  const sameChat = (a, b) => a.kind === b.kind && a.id === b.id;

  /** Cancel functions of the armed timers, by reminder id. */
  const timers = new Map();

  /** @param {Reminder} reminder */
  function arm(reminder, minDelaySeconds = 0) {
    const seconds = Math.max(minDelaySeconds, (reminder.dueAt - Date.now()) / 1000);
    timers.set(reminder.id, bot.after(seconds, () => fire(reminder.id)));
  }

  /** @param {string} id */
  async function fire(id) {
    timers.delete(id);
    const reminder = load().find((r) => r.id === id);
    if (!reminder) return; // cancelled in the meantime
    save(load().filter((r) => r.id !== id));
    const late = Date.now() - reminder.dueAt > 60_000 ? ' (late: the automator was not running)' : '';
    await bot.send(reminder.to, `Reminder: ${reminder.text}${late}`);
  }

  // Re-arm reminders saved before a reload or restart. Overdue ones wait 30
  // seconds so the Signal connection has time to come up after a restart.
  for (const reminder of load()) arm(reminder, reminder.dueAt <= Date.now() ? 30 : 0);

  // The countdown: once a minute, log how long each pending reminder has left
  // (visible in the Log tab). Does nothing while there are no reminders.
  bot.every(60, () => {
    for (const r of load()) bot.log(`${formatLeft(r.dueAt - Date.now())} left: "${r.text}"`);
  });

  bot.command('remind', async (msg) => {
    const args = msg.body.trim().replace(/^!?remind\b/i, '').trim();
    const here = load().filter((r) => sameChat(r.to, msg.conversation));

    if (!args) {
      if (here.length === 0) {
        await msg.reply('No pending reminders here. Try: remind 10 take the pizza out');
        return;
      }
      const lines = here
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((r) => `- in ${formatLeft(r.dueAt - Date.now())}: ${r.text}`);
      await msg.reply(`Pending reminders:\n${lines.join('\n')}`);
      return;
    }

    if (/^(cancel|clear|stop)$/i.test(args)) {
      for (const r of here) {
        timers.get(r.id)?.();
        timers.delete(r.id);
      }
      save(load().filter((r) => !sameChat(r.to, msg.conversation)));
      await msg.reply(here.length ? `Cancelled ${here.length} reminder(s).` : 'Nothing to cancel.');
      return;
    }

    const m = REMIND.exec(args);
    if (!m) {
      await msg.reply('Usage: remind <minutes> <text>, e.g. "remind 10 take the pizza out" or "remind 2h call mom"');
      return;
    }
    const unit = (m[2] ?? 'm').toLowerCase()[0];
    const seconds = Number(m[1]) * UNIT_SECONDS[unit];
    if (!(seconds >= 1 && seconds <= MAX_SECONDS)) {
      await msg.reply('Reminders can be between 1 second and 7 days away.');
      return;
    }

    /** @type {Reminder} */
    const reminder = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      to: msg.conversation,
      text: m[3].trim(),
      dueAt: Date.now() + seconds * 1000,
    };
    save([...load(), reminder]);
    arm(reminder);
    await msg.reply(`OK, reminding you in ${formatLeft(seconds * 1000)}: ${reminder.text}`);
  });

  bot.command('countdown', async (msg) => {
    const n = Math.min(10, Math.max(1, parseInt(msg.body.replace(/^\D*/, ''), 10) || 3));
    for (let i = n; i > 0; i--) {
      await msg.reply(String(i));
      // bot.sleep rejects if the script is reloaded meanwhile, which ends the
      // countdown quietly (the engine does not count that as a script error).
      await bot.sleep(1);
    }
    await msg.reply('Go!');
  });
}
