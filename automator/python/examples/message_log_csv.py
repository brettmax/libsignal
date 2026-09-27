#!/usr/bin/env python3
"""Append every message the automator sees to a CSV file (a simple archive).

    python examples/message_log_csv.py messages.csv
    python examples/message_log_csv.py messages.csv --incoming --replay

The server only keeps the latest 500 messages; this keeps them all. Columns:
time, direction, chat, sender, origin, ok, body. Runs until Ctrl+C.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    import signal_automator
except ImportError:  # running from a checkout without `pip install`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import signal_automator

COLUMNS = ['time', 'direction', 'chat', 'sender', 'origin', 'ok', 'body']


def row(msg: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        'time': datetime.fromtimestamp(msg['timestamp'] / 1000).isoformat(sep=' ', timespec='seconds'),
        'direction': msg.get('direction', ''),
        'chat': signal_automator.format_recipient(msg.get('peer') or {}),
        'sender': msg.get('sender', ''),
        'origin': msg.get('origin', ''),
        'ok': '' if msg.get('ok') is None else msg['ok'],
        'body': msg.get('body', ''),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('file', type=Path, help='CSV file to append to (created with a header if missing)')
    parser.add_argument('--incoming', action='store_true', help='only log incoming messages')
    parser.add_argument('--replay', action='store_true', help='start with the messages already in the log')
    parser.add_argument('--url', default=None, help='server URL (default: $AUTOMATOR_URL or http://127.0.0.1:7583)')
    args = parser.parse_args(argv)

    client = signal_automator.AutomatorClient(args.url)
    new_file = not args.file.exists() or args.file.stat().st_size == 0
    # utf-8-sig so spreadsheet programs detect UTF-8 (emoji, accents) correctly.
    with args.file.open('a', newline='', encoding='utf-8-sig' if new_file else 'utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        if new_file:
            writer.writeheader()
        print(f'logging messages from {client.url} to {args.file} (Ctrl+C to stop)', file=sys.stderr)
        try:
            for msg in client.poll_messages(
                since_timestamp=0 if args.replay else None,
                interval=2.0,
                limit=500,
                direction='incoming' if args.incoming else None,
            ):
                writer.writerow(row(msg))
                fh.flush()
        except KeyboardInterrupt:
            return 0
        except signal_automator.AutomatorError as exc:
            print(f'error: {exc}', file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
