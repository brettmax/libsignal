"""Command line interface: ``python -m signal_automator <command>``.

Examples::

    python -m signal_automator status
    python -m signal_automator send +15551234567 "Hello from the terminal"
    python -m signal_automator send group:Family "Dinner at 7"        # group by name or id
    python -m signal_automator repeat add --to Alice --every 2h --message "Stretch!" --max-runs 4
    python -m signal_automator keyword add --pattern "opening hours" --reply "9-17, Mon-Fri"
    python -m signal_automator tail
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from . import __version__
from .client import AutomatorClient, AutomatorError, MATCH_TYPES, SCOPES, default_url, rule_action
from .util import format_duration, format_recipient, needs_lookup, parse_duration, recipient, resolve_recipient


class CliError(Exception):
    """A user-facing error raised by a command (printed without a traceback)."""


# ------------------------------------------------------------------ formatting


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))


def _when(ms: Optional[float]) -> str:
    if not ms:
        return '-'
    moment = datetime.fromtimestamp(ms / 1000)
    if moment.date() == datetime.now().date():
        return moment.strftime('%H:%M:%S')
    return moment.strftime('%Y-%m-%d %H:%M')


def _countdown(ms: Optional[float]) -> str:
    if not ms:
        return '-'
    left = ms / 1000 - time.time()
    return 'due' if left <= 0 else f'in {format_duration(left)}'


def _clip(value: Any, width: int) -> str:
    text = ' '.join(str(value if value is not None else '').split())
    return text if len(text) <= width else text[: width - 1] + '…'


def _short(item_id: Any) -> str:
    """Ids are uuids; tables show the first 8 characters (any unique prefix works as an argument)."""
    return str(item_id or '')[:8]


def _table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> None:
    cells = [[str(c) for c in headers]] + [[str(c) for c in row] for row in rows]
    widths = [max(len(row[i]) for row in cells) for i in range(len(headers))]
    for row in cells:
        print('  '.join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip())


class Names:
    """Display names for contacts and groups, from one /api/state snapshot."""

    def __init__(self, state: Optional[Mapping[str, Any]] = None) -> None:
        state = state or {}
        self.contacts: Dict[str, str] = {}
        for c in state.get('contacts') or []:
            name = c.get('name')
            if name:
                for key in (c.get('id'), c.get('number'), c.get('uuid')):
                    if key:
                        self.contacts[key] = name
        self.groups: Dict[str, str] = {g['id']: g.get('name') or '' for g in state.get('groups') or [] if g.get('id')}

    def contact(self, cid: Optional[str], fallback: Optional[str] = None) -> str:
        name = fallback or self.contacts.get(cid or '')
        return f'{name} ({cid})' if name and name != cid else str(cid or '?')

    def recipient(self, r: Mapping[str, Any]) -> str:
        if r.get('kind') == 'group':
            return self.groups.get(str(r.get('id')), '') or format_recipient(r)
        return self.contact(r.get('id'))


def _format_message(m: Mapping[str, Any], names: Names) -> str:
    peer = m.get('peer') or {}
    body = str(m.get('body') or '').replace('\n', '\n' + ' ' * 22)
    stamp = datetime.fromtimestamp((m.get('timestamp') or 0) / 1000).strftime('%Y-%m-%d %H:%M:%S')
    if m.get('direction') == 'incoming':
        who = names.contact(m.get('sender'), m.get('senderName'))
        if peer.get('kind') == 'group':
            who = f'{names.recipient(peer)} / {who}'
        return f'{stamp}  <- {who}: {body}'
    origin = m.get('origin') or '?'
    ref = m.get('originRef')
    tag = f'{origin}:{ref}' if ref and origin in ('script',) else origin
    line = f'{stamp}  -> {names.recipient(peer)} [{tag}]: {body}'
    if m.get('ok') is False:
        line += f"  [FAILED: {m.get('error') or 'unknown error'}]"
    return line


# --------------------------------------------------------------------- lookups


class Lookup:
    """Resolves names to recipients and id prefixes to ids, fetching state lazily."""

    def __init__(self, client: AutomatorClient) -> None:
        self.client = client
        self._state: Optional[Dict[str, Any]] = None

    @property
    def state(self) -> Dict[str, Any]:
        if self._state is None:
            self._state = self.client.state()
        return self._state

    def recipient(self, text: str) -> Dict[str, str]:
        """A number, uuid, contact name, ``group:<id>`` or ``group:<name>``."""
        if not needs_lookup(text):
            return recipient(text)
        return resolve_recipient(text, self.state.get('contacts') or [], self.state.get('groups') or [])

    @staticmethod
    def pick(items: Sequence[Mapping[str, Any]], given: str, what: str) -> Mapping[str, Any]:
        """Find an item by exact id, unique id prefix, or exact name."""
        for item in items:
            if item.get('id') == given:
                return item
        prefixed = [i for i in items if str(i.get('id', '')).startswith(given)]
        if len(prefixed) == 1:
            return prefixed[0]
        named = [i for i in items if str(i.get('name', '')).casefold() == given.casefold()]
        if len(named) == 1:
            return named[0]
        if len(prefixed) > 1 or len(named) > 1:
            raise CliError(f'{given!r} matches several {what}s; give more of the id')
        raise CliError(f"no {what} with id or name {given!r} (see the 'list' command)")

    def script_name(self, given: str) -> str:
        names = [s['name'] for s in self.client.list_scripts()]
        if given in names:
            return given
        for candidate in (given + '.js', given + '.mjs'):
            if candidate in names:
                return candidate
        raise CliError(f"no script called {given!r}; scripts: {', '.join(names) or '(none)'}")


# -------------------------------------------------------------------- commands


def cmd_status(client: AutomatorClient, args: argparse.Namespace) -> int:
    state = client.state()
    if args.json:
        _print_json({k: v for k, v in state.items() if k not in ('messages', 'logs')})
        return 0
    st = state.get('status') or {}
    reps = state.get('repeaters') or []
    rules = state.get('rules') or []
    scripts = state.get('scripts') or []
    msgs = state.get('messages') or []
    print(f'Server     {client.url}')
    print(f"Transport  {st.get('kind')} ({st.get('state')})" + (f" - {st['detail']}" if st.get('detail') else ''))
    print(f"Account    {st.get('account') or '(unknown)'}")
    print(f"Repeaters  {len(reps)} ({sum(1 for r in reps if r.get('enabled'))} running)")
    print(f"Rules      {len(rules)} ({sum(1 for r in rules if r.get('enabled'))} enabled)")
    broken = [s['name'] for s in scripts if s.get('error')]
    errors = f", errors in: {', '.join(broken)}" if broken else ''
    print(f"Scripts    {len(scripts)} ({sum(1 for s in scripts if s.get('loaded'))} loaded{errors})")
    print(f"Contacts   {len(state.get('contacts') or [])}, groups: {len(state.get('groups') or [])}")
    print(f'Messages   {len(msgs)} in log' + (f", latest {_when(msgs[0].get('timestamp'))}" if msgs else ''))
    return 0 if st.get('state') == 'connected' else 3


def cmd_contacts(client: AutomatorClient, args: argparse.Namespace) -> int:
    data = client.refresh_contacts() if args.refresh else client.state()
    contacts, groups = data.get('contacts') or [], data.get('groups') or []
    if args.json:
        _print_json({'contacts': contacts, 'groups': groups})
        return 0
    rows = sorted(([c.get('id', ''), c.get('name') or ''] for c in contacts), key=lambda r: (r[1].casefold(), r[0]))
    _table(['CONTACT', 'NAME'], rows)
    print()
    grows = sorted(
        ([f"group:{g.get('id', '')}", g.get('name') or '', g.get('memberCount', '')] for g in groups),
        key=lambda r: str(r[1]).casefold(),
    )
    _table(['GROUP (use as recipient)', 'NAME', 'MEMBERS'], grows)
    return 0


def cmd_send(client: AutomatorClient, args: argparse.Namespace) -> int:
    body = sys.stdin.read() if args.text == ['-'] else ' '.join(args.text)
    if not body.strip():
        raise CliError('the message is empty')
    lookup = Lookup(client)
    to = lookup.recipient(args.to)
    msg = client.send(to, body.rstrip('\n') if args.text == ['-'] else body)
    if args.json:
        _print_json(msg)
    elif msg.get('ok') is False:
        raise CliError(f"sending failed: {msg.get('error') or 'unknown error'}")
    else:
        names = Names(lookup._state)
        print(f"Sent to {names.recipient(msg.get('peer') or to)} at {_when(msg.get('timestamp'))}.")
    return 0


def _repeater_rows(reps: Sequence[Mapping[str, Any]], names: Names) -> List[List[Any]]:
    rows = []
    for r in reps:
        runs = f"{r.get('runCount', 0)}/{r['maxRuns']}" if r.get('maxRuns') is not None else str(r.get('runCount', 0))
        nxt = _countdown(r.get('nextRunAt')) if r.get('enabled') else 'stopped'
        jitter = f"+{format_duration(r['jitterSeconds'])}" if r.get('jitterSeconds') else ''
        rows.append(
            [
                _short(r.get('id')),
                _clip(r.get('name'), 24),
                'yes' if r.get('enabled') else 'no',
                format_duration(r.get('intervalSeconds') or 0) + jitter,
                runs,
                nxt,
                _clip(', '.join(names.recipient(x) for x in r.get('recipients') or []), 40),
                _clip(' | '.join(r.get('messages') or []), 40),
            ]
        )
    return rows


def cmd_repeat_list(client: AutomatorClient, args: argparse.Namespace) -> int:
    state = client.state()
    reps = state.get('repeaters') or []
    if args.json:
        _print_json(reps)
        return 0
    if not reps:
        print('No repeaters yet. Create one with: repeat add --to <recipient> --every 10m --message "..."')
        return 0
    _table(['ID', 'NAME', 'ON', 'EVERY', 'RUNS', 'NEXT', 'TO', 'MESSAGES'], _repeater_rows(reps, Names(state)))
    return 0


def cmd_repeat_add(client: AutomatorClient, args: argparse.Namespace) -> int:
    lookup = Lookup(client)
    targets = [lookup.recipient(t) for t in args.to]
    rep = client.create_repeater(
        targets,
        args.message,
        every=args.every,
        name=args.name,
        jitter=args.jitter,
        max_runs=args.max_runs,
        enabled=not args.disabled,
    )
    if args.json:
        _print_json(rep)
    else:
        state = 'starts ' + _countdown(rep.get('nextRunAt')) if rep.get('enabled') else 'created disabled'
        print(f"Repeater {_short(rep.get('id'))} \"{rep.get('name')}\" every {format_duration(rep.get('intervalSeconds') or 0)}: {state}.")
    return 0


def _repeater_action(fn: Callable[[AutomatorClient, str], Any], done: str) -> Callable[[AutomatorClient, argparse.Namespace], int]:
    def run(client: AutomatorClient, args: argparse.Namespace) -> int:
        rep = Lookup.pick(client.list_repeaters(), args.id, 'repeater')
        result = fn(client, rep['id'])
        if args.json:
            _print_json(result if result is not None else {'deleted': rep['id']})
        else:
            extra = ''
            if isinstance(result, Mapping) and result.get('enabled') and result.get('nextRunAt'):
                extra = f"; next run {_countdown(result['nextRunAt'])}"
            print(f"{done} repeater {_short(rep['id'])} \"{rep.get('name')}\"{extra}.")
        return 0

    return run


def _action_text(action: Mapping[str, Any], names: Names) -> str:
    kind = action.get('type')
    if kind == 'reply':
        return f"reply: {action.get('text', '')}"
    if kind == 'send':
        return f"send to {names.recipient(action.get('to') or {})}: {action.get('text', '')}"
    if kind == 'script':
        return f"script command: {action.get('command', '')}"
    return json.dumps(action)


def cmd_keyword_list(client: AutomatorClient, args: argparse.Namespace) -> int:
    state = client.state()
    rules = state.get('rules') or []
    if args.json:
        _print_json(rules)
        return 0
    if not rules:
        print('No keyword rules yet. Create one with: keyword add --pattern hello --reply "Hi {{senderName}}!"')
        return 0
    names = Names(state)
    rows = []
    for r in rules:
        flags = [r.get('scope', 'all')]
        if r.get('caseSensitive'):
            flags.append('case')
        if r.get('cooldownSeconds'):
            flags.append('cooldown ' + format_duration(r['cooldownSeconds']))
        if r.get('stopProcessing'):
            flags.append('stop')
        if r.get('fromFilter'):
            flags.append('from ' + ','.join(r['fromFilter']))
        rows.append(
            [
                _short(r.get('id')),
                _clip(r.get('name'), 20),
                'yes' if r.get('enabled') else 'no',
                r.get('matchType', ''),
                _clip(r.get('pattern'), 24),
                _clip(_action_text(r.get('action') or {}, names), 40),
                _clip(' '.join(flags), 30),
                r.get('triggerCount', 0),
            ]
        )
    _table(['ID', 'NAME', 'ON', 'MATCH', 'PATTERN', 'ACTION', 'OPTIONS', 'HITS'], rows)
    return 0


def cmd_keyword_add(client: AutomatorClient, args: argparse.Namespace) -> int:
    lookup = Lookup(client)
    if args.send_to is not None and args.text is None:
        raise CliError('--send-to also needs --text')
    if args.text is not None and args.send_to is None:
        raise CliError('--text is only used with --send-to (for a reply use --reply)')
    action = rule_action(
        reply=args.reply,
        send_to=lookup.recipient(args.send_to) if args.send_to else None,
        text=args.text,
        command=args.command,
    )
    senders = [lookup.recipient(s)['id'] for s in args.sender or []]
    rule = client.create_rule(
        args.pattern,
        action=action,
        match=args.match,
        name=args.name,
        case_sensitive=args.case_sensitive,
        scope=args.scope,
        from_filter=senders,
        cooldown=args.cooldown,
        stop_processing=args.stop,
        enabled=not args.disabled,
    )
    if args.json:
        _print_json(rule)
    else:
        print(f"Rule {_short(rule.get('id'))} \"{rule.get('name')}\" ({rule.get('matchType')} {rule.get('pattern')!r}) created.")
    return 0


def _rule_action_cmd(fn: Callable[[AutomatorClient, str], Any], done: str) -> Callable[[AutomatorClient, argparse.Namespace], int]:
    def run(client: AutomatorClient, args: argparse.Namespace) -> int:
        rule = Lookup.pick(client.list_rules(), args.id, 'rule')
        result = fn(client, rule['id'])
        if args.json:
            _print_json(result if result is not None else {'deleted': rule['id']})
        else:
            print(f"{done} rule {_short(rule['id'])} \"{rule.get('name')}\".")
        return 0

    return run


def cmd_keyword_test(client: AutomatorClient, args: argparse.Namespace) -> int:
    text = ' '.join(args.text)
    result = client.test_rules(text, sender=args.sender, group=args.group)
    if args.json:
        _print_json(result)
        return 0
    matches = result.get('matches') or []
    if not matches:
        print('No rule matches.')
        return 1
    rules = {r['id']: r for r in client.list_rules()}
    for m in matches:
        rule = rules.get(m.get('ruleId'), {})
        output = m.get('output')
        what = f'would send: {output}' if output is not None else f"would run script command {((rule.get('action') or {}).get('command'))!r}"
        print(f"{rule.get('name', m.get('ruleId'))}: {what}")
    return 0


def cmd_script_list(client: AutomatorClient, args: argparse.Namespace) -> int:
    scripts = client.list_scripts()
    if args.json:
        _print_json(scripts)
        return 0
    if not scripts:
        print('No scripts. Put .js files in the scripts folder, then run: script reload')
        return 0
    rows = [
        [
            s.get('name', ''),
            'yes' if s.get('enabled') else 'no',
            'yes' if s.get('loaded') else 'no',
            ', '.join(s.get('commands') or []) or '-',
            _clip(s.get('error') or '', 60),
        ]
        for s in scripts
    ]
    _table(['NAME', 'ENABLED', 'LOADED', 'COMMANDS', 'ERROR'], rows)
    return 0


def cmd_script_reload(client: AutomatorClient, args: argparse.Namespace) -> int:
    scripts = client.reload_scripts()
    if args.json:
        _print_json(scripts)
        return 0
    failed = [s for s in scripts if s.get('error')]
    print(f"Reloaded {sum(1 for s in scripts if s.get('loaded'))} of {len(scripts)} script(s).")
    for s in failed:
        print(f"  {s['name']}: {s['error']}")
    return 1 if failed else 0


def _script_toggle(enabled: bool) -> Callable[[AutomatorClient, argparse.Namespace], int]:
    def run(client: AutomatorClient, args: argparse.Namespace) -> int:
        name = Lookup(client).script_name(args.name)
        info = client.set_script_enabled(name, enabled)
        if args.json:
            _print_json(info)
            return 0
        line = f"{name}: {'enabled' if enabled else 'disabled'}"
        if info.get('loaded'):
            line += ', loaded'
        if info.get('error'):
            line += f" (error: {info['error']})"
        print(line)
        return 1 if info.get('error') else 0

    return run


def cmd_simulate(client: AutomatorClient, args: argparse.Namespace) -> int:
    body = ' '.join(args.text)
    lookup = Lookup(client)
    sender = args.sender
    if needs_lookup(sender):
        sender = lookup.recipient(sender)['id']
    group = None
    if args.group:
        spec = args.group if args.group.startswith('group:') else 'group:' + args.group
        group = lookup.recipient(spec)['id']
    if client.status().get('kind') != 'mock':
        print('note: not in mock mode - replies from rules and scripts are really sent over Signal.', file=sys.stderr)
    client.simulate_incoming(sender, body, group_id=group)
    if not args.json:
        print(f'Injected an incoming message from {sender}' + (f' in group {group}' if group else '') + '.')
    return 0


def cmd_tail(client: AutomatorClient, args: argparse.Namespace) -> int:
    try:
        names = Names(client.state())
    except AutomatorError:
        names = Names()
    direction = 'incoming' if args.incoming else 'outgoing' if args.outgoing else None
    since: Optional[float] = None
    shown = 0

    def show(m: Mapping[str, Any]) -> None:
        if args.json:
            print(json.dumps(m, ensure_ascii=False), flush=True)
        else:
            print(_format_message(m, names), flush=True)

    if args.last:
        history = [m for m in reversed(client.messages(args.last)) if direction is None or m.get('direction') == direction]
        for m in history:
            show(m)
        since = max((m.get('timestamp') or 0 for m in history), default=None)
    if not args.json:
        print(f'-- waiting for messages from {client.url} (Ctrl+C to stop)', file=sys.stderr, flush=True)
    for m in client.poll_messages(since_timestamp=since, interval=args.interval, limit=args.limit, direction=direction):
        show(m)
        shown += 1
        if args.exit_after and shown >= args.exit_after:
            break
    return 0


# ---------------------------------------------------------------------- parser


def _duration(text: str) -> Any:
    try:
        return parse_duration(text)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _positive_duration(text: str) -> Any:
    value = _duration(text)
    if value < 1:
        raise argparse.ArgumentTypeError('must be at least 1 second')
    return value


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f'not a whole number: {text!r}') from None
    if value < 1:
        raise argparse.ArgumentTypeError('must be 1 or more')
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='python -m signal_automator',
        description='Control a running Signal Automator from the command line.',
        epilog='Recipients: +15551234567, a uuid, a contact name, or group:<id or name>. '
        'Durations: 30s, 10m, 2h, 1d, 1h30m.',
    )
    parser.add_argument('--url', default=None, help=f'server URL (default: $AUTOMATOR_URL or {default_url()})')
    parser.add_argument('--timeout', type=float, default=30.0, help='HTTP timeout in seconds (default 30)')
    parser.add_argument('--json', action='store_true', help='print raw JSON instead of tables')
    parser.add_argument('--version', action='version', version=f'signal_automator {__version__}')
    sub = parser.add_subparsers(dest='command', metavar='COMMAND', required=True)

    p = sub.add_parser('status', help='show the Signal connection and what is configured')
    p.set_defaults(func=cmd_status)

    p = sub.add_parser('contacts', help='list contacts and groups (with the ids to use as recipients)')
    p.add_argument('--refresh', action='store_true', help='reload them from signal-cli first')
    p.set_defaults(func=cmd_contacts)

    p = sub.add_parser('send', help='send a message now')
    p.add_argument('to', help='+number, uuid, contact name, or group:<id or name>')
    p.add_argument('text', nargs='+', help='message text (several words are joined; "-" reads stdin)')
    p.set_defaults(func=cmd_send)

    # repeat
    rep = sub.add_parser('repeat', help='repeating messages with a countdown between sends')
    rsub = rep.add_subparsers(dest='action', metavar='ACTION', required=True)
    p = rsub.add_parser('add', help='create a repeater')
    p.add_argument('--to', action='append', required=True, help='recipient (repeat --to for several)')
    p.add_argument('--every', type=_positive_duration, required=True, help='pause between sends, e.g. 10m')
    p.add_argument(
        '--message', '-m', action='append', required=True, help='message text (repeat -m to rotate through several)'
    )
    p.add_argument('--max-runs', type=_positive_int, default=None, help='stop after N sends (default: forever)')
    p.add_argument('--jitter', type=_duration, default=0, help='random extra delay 0..JITTER per pause, e.g. 30s')
    p.add_argument('--name', default=None, help='name shown in the UI')
    p.add_argument('--disabled', action='store_true', help='create it stopped')
    p.set_defaults(func=cmd_repeat_add)
    p = rsub.add_parser('list', aliases=['ls'], help='list repeaters with their countdowns')
    p.set_defaults(func=cmd_repeat_list)
    for name, aliases, fn, done, help_text in (
        ('run', [], lambda c, i: c.run_repeater(i), 'Ran', 'send the next message now and restart the countdown'),
        ('enable', ['start'], lambda c, i: c.enable_repeater(i), 'Started', 'start the countdown'),
        ('disable', ['stop'], lambda c, i: c.disable_repeater(i), 'Stopped', 'stop the countdown'),
        ('rm', ['delete'], lambda c, i: c.delete_repeater(i), 'Deleted', 'delete a repeater'),
    ):
        p = rsub.add_parser(name, aliases=aliases, help=help_text)
        p.add_argument('id', help='repeater id (a unique prefix is enough) or exact name')
        p.set_defaults(func=_repeater_action(fn, done))

    # keyword
    kw = sub.add_parser('keyword', help='keyword rules that react to incoming messages')
    ksub = kw.add_subparsers(dest='action', metavar='ACTION', required=True)
    p = ksub.add_parser('add', help='create a keyword rule')
    p.add_argument('--pattern', required=True, help='text (or regex) to look for')
    act = p.add_mutually_exclusive_group(required=True)
    act.add_argument('--reply', help='reply text; placeholders: {{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}} {{1}}..{{9}}')
    act.add_argument('--send-to', help='send --text to this recipient instead of replying')
    act.add_argument('--command', help='run this bot.command() from a user script')
    p.add_argument('--text', help='text for --send-to (same placeholders as --reply)')
    p.add_argument('--match', default='contains', help=f"how to match: {', '.join(MATCH_TYPES)} (default contains)")
    p.add_argument('--case-sensitive', action='store_true', help='match case exactly')
    p.add_argument('--scope', choices=SCOPES, default='all', help='which chats: all (default), direct, groups')
    p.add_argument('--from', dest='sender', action='append', help='only react to this sender (repeatable)')
    p.add_argument('--cooldown', type=_duration, default=0, help='minimum time between triggers per chat, e.g. 1h')
    p.add_argument('--stop', action='store_true', help='skip later rules when this one matches')
    p.add_argument('--name', default=None, help='name shown in the UI (default: the pattern)')
    p.add_argument('--disabled', action='store_true', help='create it switched off')
    p.set_defaults(func=cmd_keyword_add)
    p = ksub.add_parser('list', aliases=['ls'], help='list keyword rules in evaluation order')
    p.set_defaults(func=cmd_keyword_list)
    p = ksub.add_parser('test', help='dry run: which rules would match a message (nothing is sent)')
    p.add_argument('text', nargs='+', help='message text')
    p.add_argument('--sender', default=None, help='pretend this number sent it')
    p.add_argument('--group', action='store_true', help='pretend it was a group message')
    p.set_defaults(func=cmd_keyword_test)
    for name, aliases, fn, done, help_text in (
        ('enable', ['on'], lambda c, i: c.enable_rule(i), 'Enabled', 'switch a rule on'),
        ('disable', ['off'], lambda c, i: c.disable_rule(i), 'Disabled', 'switch a rule off'),
        ('rm', ['delete'], lambda c, i: c.delete_rule(i), 'Deleted', 'delete a rule'),
    ):
        p = ksub.add_parser(name, aliases=aliases, help=help_text)
        p.add_argument('id', help='rule id (a unique prefix is enough) or exact name')
        p.set_defaults(func=_rule_action_cmd(fn, done))

    # script
    sc = sub.add_parser('script', help='user scripts in the scripts folder')
    ssub = sc.add_subparsers(dest='action', metavar='ACTION', required=True)
    p = ssub.add_parser('list', aliases=['ls'], help='list scripts, their commands and errors')
    p.set_defaults(func=cmd_script_list)
    p = ssub.add_parser('reload', help='rescan the scripts folder and reload every enabled script')
    p.set_defaults(func=cmd_script_reload)
    for name, enabled in (('enable', True), ('disable', False)):
        p = ssub.add_parser(name, help=f'{name} a script')
        p.add_argument('name', help='file name, e.g. away-autoreply.js (.js may be left out)')
        p.set_defaults(func=_script_toggle(enabled))

    p = sub.add_parser('simulate', help='inject a fake incoming message to try rules and scripts')
    p.add_argument('--from', dest='sender', required=True, help='pretend sender: number, uuid or contact name')
    p.add_argument('--group', default=None, help='pretend it was sent in this group (id or name)')
    p.add_argument('text', nargs='+', help='message text')
    p.set_defaults(func=cmd_simulate)

    p = sub.add_parser('tail', help='print messages as they arrive (polls the message log)')
    p.add_argument('--interval', type=float, default=2.0, help='seconds between polls (default 2)')
    p.add_argument('--last', type=int, default=0, help='first print the last N messages')
    p.add_argument('--limit', type=_positive_int, default=100, help='messages fetched per poll (default 100)')
    p.add_argument('--exit-after', type=int, default=0, help='exit after N new messages')
    way = p.add_mutually_exclusive_group()
    way.add_argument('--incoming', action='store_true', help='only incoming messages')
    way.add_argument('--outgoing', action='store_true', help='only outgoing messages')
    p.set_defaults(func=cmd_tail)
    return parser


def _configure_streams() -> None:
    # Message bodies may contain characters the console encoding cannot show
    # (emoji on a Windows code page); print a replacement instead of crashing.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if callable(reconfigure):
            try:
                reconfigure(errors='replace')
            except ValueError:
                pass


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _configure_streams()
    logging.basicConfig(level=logging.WARNING, format='warning: %(message)s')
    client = AutomatorClient(args.url, timeout=args.timeout)
    try:
        return int(args.func(client, args))
    except (AutomatorError, CliError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    except (TypeError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        # Output piped into something like `head` that exited early.
        try:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
        except (OSError, ValueError):
            pass
        return 0
