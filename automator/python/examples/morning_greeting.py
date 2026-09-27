#!/usr/bin/env python3
"""Send a greeting every morning at a fixed time of day.

Repeaters in the UI count down a fixed interval from when they start; this
example schedules by the clock instead:

    python examples/morning_greeting.py --to +15551234567 --at 07:30
    python examples/morning_greeting.py --to 'group:Family' --at 08:00 --weekdays \\
        --message 'Good morning, everyone!' --message 'Morning! Have a great day.'

With several --message options it rotates through them day by day. It keeps
running until Ctrl+C; --dry-run prints the schedule without sending. Needs a
running Signal Automator (AUTOMATOR_URL, default http://127.0.0.1:7583).
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional, Sequence

try:
    import signal_automator
except ImportError:  # running from a checkout without `pip install`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import signal_automator


def next_run(at: str, weekdays_only: bool, now: Optional[datetime] = None) -> datetime:
    """The next moment the clock shows ``at`` (HH:MM), skipping weekends if asked."""
    now = now or datetime.now()
    hour, minute = (int(part) for part in at.split(':'))
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    while weekdays_only and candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def time_of_day(text: str) -> str:
    try:
        datetime.strptime(text, '%H:%M')
    except ValueError:
        raise argparse.ArgumentTypeError(f'expected HH:MM, got {text!r}') from None
    return text


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--to', required=True, help='+number, uuid, contact name or group:<id or name>')
    parser.add_argument('--at', type=time_of_day, default='08:00', help='time of day, HH:MM (default 08:00)')
    parser.add_argument('--message', '-m', action='append', help='text to send (repeat to rotate)')
    parser.add_argument('--weekdays', action='store_true', help='skip Saturdays and Sundays')
    parser.add_argument('--dry-run', action='store_true', help='print what would be sent, then exit')
    parser.add_argument('--url', default=None, help='server URL (default: $AUTOMATOR_URL or http://127.0.0.1:7583)')
    args = parser.parse_args(argv)
    messages: List[str] = args.message or ['Good morning!']

    client = signal_automator.AutomatorClient(args.url)
    try:
        to = client.find_recipient(args.to)
    except (signal_automator.AutomatorError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1

    if args.dry_run:
        when = datetime.now()
        for _ in range(5):
            when = next_run(args.at, args.weekdays, when)
            print(f'{when:%a %Y-%m-%d %H:%M}  {messages[when.toordinal() % len(messages)]}')
        return 0

    print(f'Greeting {signal_automator.format_recipient(to)} at {args.at}' + (' on weekdays' if args.weekdays else ' every day'))
    try:
        while True:
            when = next_run(args.at, args.weekdays)
            print(f'next greeting: {when:%a %Y-%m-%d %H:%M}', flush=True)
            # Sleep in short steps so a changed system clock or a laptop that
            # was asleep does not throw the schedule off by much.
            while datetime.now() < when:
                time.sleep(min(60.0, max(0.5, (when - datetime.now()).total_seconds())))
            text = messages[when.toordinal() % len(messages)]
            try:
                sent = client.send(to, text)
                print(f'sent at {datetime.now():%H:%M:%S}: {sent["body"]}', flush=True)
            except signal_automator.AutomatorError as exc:
                # Keep going: tomorrow the server may be back.
                print(f'could not send: {exc}', file=sys.stderr, flush=True)
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main())
