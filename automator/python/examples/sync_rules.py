#!/usr/bin/env python3
"""Keep keyword rules in code: create or update them by name, idempotently.

Edit RULES below and run it again whenever you change them:

    python examples/sync_rules.py            # apply
    python examples/sync_rules.py --dry-run  # show what would change

Rules are matched by name. Rules created in the UI with other names are left
alone (pass --prune to delete every rule that is not listed here).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

try:
    import signal_automator
except ImportError:  # running from a checkout without `pip install`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import signal_automator

# Each entry uses the API's KeywordRuleInput fields (see automator/shared/src/index.ts).
# Templates: {{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}} {{1}}..{{9}}
RULES: List[Dict[str, Any]] = [
    {
        'name': 'Opening hours',
        'pattern': 'opening hours',
        'matchType': 'contains',
        'scope': 'direct',
        'action': {'type': 'reply', 'text': 'Hi {{senderName}}! We are open Mon-Fri 9:00-17:00.'},
        'cooldownSeconds': 3600,
    },
    {
        'name': 'Order status',
        'pattern': r'^order\s+#?(\d+)$',
        'matchType': 'regex',
        'action': {'type': 'reply', 'text': 'Thanks! I will look up order {{1}} and get back to you.'},
    },
    {
        'name': 'Remind (countdown-reminder.js)',
        'pattern': 'remind',
        'matchType': 'startsWith',
        'scope': 'direct',
        'action': {'type': 'script', 'command': 'remind'},
    },
]

DEFAULTS: Dict[str, Any] = {
    'enabled': True,
    'matchType': 'contains',
    'caseSensitive': False,
    'scope': 'all',
    'fromFilter': [],
    'cooldownSeconds': 0,
    'stopProcessing': False,
}


def changes(current: Dict[str, Any], wanted: Dict[str, Any]) -> Dict[str, Any]:
    """The fields of ``wanted`` that differ from the existing rule."""
    return {key: value for key, value in wanted.items() if current.get(key) != value}


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='only print what would change')
    parser.add_argument('--prune', action='store_true', help='delete rules that are not listed in RULES')
    parser.add_argument('--url', default=None, help='server URL (default: $AUTOMATOR_URL or http://127.0.0.1:7583)')
    args = parser.parse_args(argv)

    client = signal_automator.AutomatorClient(args.url)
    try:
        existing = {rule['name']: rule for rule in client.list_rules()}
        for spec in RULES:
            wanted = {**DEFAULTS, **spec}
            current = existing.get(wanted['name'])
            if current is None:
                print(f"create  {wanted['name']}")
                if not args.dry_run:
                    client.create_rule_raw(wanted)
                continue
            diff = changes(current, wanted)
            if diff:
                print(f"update  {wanted['name']}: {', '.join(sorted(diff))}")
                if not args.dry_run:
                    client.update_rule(current['id'], **diff)
            else:
                print(f"ok      {wanted['name']}")
        if args.prune:
            listed = {spec['name'] for spec in RULES}
            for name, rule in existing.items():
                if name not in listed:
                    print(f'delete  {name}')
                    if not args.dry_run:
                        client.delete_rule(rule['id'])
    except signal_automator.AutomatorError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
