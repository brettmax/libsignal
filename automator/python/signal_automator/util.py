"""Helpers shared by the client and the CLI: durations and recipients."""

from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Sequence, Union

Number = Union[int, float]

_UNIT_SECONDS = {
    's': 1, 'sec': 1, 'secs': 1, 'second': 1, 'seconds': 1,
    'm': 60, 'min': 60, 'mins': 60, 'minute': 60, 'minutes': 60,
    'h': 3600, 'hr': 3600, 'hrs': 3600, 'hour': 3600, 'hours': 3600,
    'd': 86400, 'day': 86400, 'days': 86400,
    'w': 604800, 'week': 604800, 'weeks': 604800,
}

_PART = re.compile(r'(\d+(?:\.\d+)?|\.\d+)([a-z]+)')
_NUMBER = re.compile(r'\d+(?:\.\d+)?|\.\d+')
_PHONE = re.compile(r'\+?[\d\s().\-]{5,}')
_UUID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')


def _whole(value: float) -> Number:
    return int(value) if float(value).is_integer() else value


def parse_duration(value: Union[str, Number]) -> Number:
    """Convert a duration to seconds.

    Accepts a number of seconds (``90``, ``"90"``), or a string with units:
    ``"30s"``, ``"10m"``, ``"2h"``, ``"1d"``, ``"1w"``, combinations such as
    ``"1h30m"`` or ``"1h 30m"``, decimals (``"1.5h"``) and long unit names
    (``"5 minutes"``). Returns an int when the result is whole, else a float.

    Raises ValueError for anything else, including negative durations.
    """
    if isinstance(value, bool):
        raise TypeError("duration must be a number or a string like '10m'")
    if isinstance(value, (int, float)):
        if value < 0:
            raise ValueError(f'duration must not be negative: {value!r}')
        return _whole(float(value))
    if not isinstance(value, str):
        raise TypeError("duration must be a number or a string like '10m'")

    text = re.sub(r'\s+', '', value.strip().lower())
    if not text:
        raise ValueError('empty duration')
    if _NUMBER.fullmatch(text):
        return _whole(float(text))

    total = 0.0
    pos = 0
    for part in _PART.finditer(text):
        if part.start() != pos:
            break
        unit = part.group(2)
        if unit not in _UNIT_SECONDS:
            raise ValueError(
                f'unknown unit {unit!r} in duration {value!r} (use s, m, h, d or w, e.g. 30s, 10m, 2h, 1d)'
            )
        total += float(part.group(1)) * _UNIT_SECONDS[unit]
        pos = part.end()
    if pos != len(text) or pos == 0:
        raise ValueError(f'invalid duration {value!r} (examples: 30s, 10m, 2h, 1d, 1h30m)')
    return _whole(total)


def format_duration(seconds: Number) -> str:
    """Render seconds compactly, keeping the two largest units: ``5400 -> '1h 30m'``."""
    if seconds is None:
        return '-'
    negative = seconds < 0
    remaining = int(round(abs(seconds)))
    parts = []
    for unit, size in (('d', 86400), ('h', 3600), ('m', 60), ('s', 1)):
        if remaining >= size:
            count, remaining = divmod(remaining, size)
            parts.append(f'{count}{unit}')
    text = ' '.join(parts[:2]) if parts else '0s'
    return f'-{text}' if negative else text


def recipient(value: Union[str, Mapping[str, Any]]) -> Dict[str, str]:
    """Normalise a recipient to the API's ``{"kind": ..., "id": ...}`` form.

    Accepts a dict with ``kind`` ("contact" or "group") and ``id``, or a string:

    * ``"group:<base64 id>"`` - a group
    * ``"+15551234567"`` - a contact by number (spaces, dashes, dots and
      parentheses are removed, so ``"+1 (555) 123-4567"`` works too)
    * anything else - a contact id as-is (for example an ACI uuid)
    """
    if isinstance(value, Mapping):
        kind = value.get('kind')
        rid = value.get('id')
        if kind not in ('contact', 'group'):
            raise ValueError(f"recipient kind must be 'contact' or 'group', got {kind!r}")
        if not isinstance(rid, str) or not rid.strip():
            raise ValueError('recipient id must be a non-empty string')
        return {'kind': kind, 'id': rid.strip()}
    if not isinstance(value, str):
        raise TypeError(f'recipient must be a string or a dict, got {type(value).__name__}')
    text = value.strip()
    if text.lower().startswith('group:'):
        group_id = text[len('group:'):].strip()
        if not group_id:
            raise ValueError("empty group id in 'group:'")
        return {'kind': 'group', 'id': group_id}
    if text.lower().startswith('contact:'):
        text = text[len('contact:'):].strip()
    if not text:
        raise ValueError('empty recipient')
    if _PHONE.fullmatch(text):
        text = re.sub(r'[\s().\-]', '', text)
    return {'kind': 'contact', 'id': text}


def format_recipient(value: Mapping[str, Any]) -> str:
    """The inverse of :func:`recipient` for display: ``group:<id>`` or the contact id."""
    if not isinstance(value, Mapping):
        return str(value)
    if value.get('kind') == 'group':
        return f"group:{value.get('id', '')}"
    return str(value.get('id', ''))


def needs_lookup(text: str) -> bool:
    """True when ``text`` names a contact or group instead of giving an id,
    i.e. :func:`resolve_recipient` needs the contact and group lists."""
    text = text.strip()
    if text.lower().startswith('group:'):
        return True  # could be a group name; resolve_recipient falls back to the id
    if text.lower().startswith('contact:'):
        return False
    return not (_PHONE.fullmatch(text) or _UUID.fullmatch(text))


def resolve_recipient(
    text: str,
    contacts: Sequence[Mapping[str, Any]] = (),
    groups: Sequence[Mapping[str, Any]] = (),
) -> Dict[str, str]:
    """Like :func:`recipient`, but also understands names.

    Accepts a number, a uuid, ``group:<id>``, a contact name (``"Alice"``)
    or ``group:<group name>``, all matched case-insensitively against the given
    ``contacts`` and ``groups`` (as returned by ``GET /api/state``).
    ``group:<text>`` that matches neither a group id nor a name is used as an id.

    Raises ValueError for an unknown or ambiguous name.
    """
    text = text.strip()
    if text.lower().startswith('group:'):
        key = text[len('group:'):].strip()
        if any(g.get('id') == key for g in groups):
            return {'kind': 'group', 'id': key}
        named = [g for g in groups if str(g.get('name') or '').casefold() == key.casefold()]
        if len(named) > 1:
            raise ValueError(f'several groups are called {key!r}; use group:<id> instead')
        if named:
            return {'kind': 'group', 'id': str(named[0]['id'])}
        return recipient(text)
    if not needs_lookup(text):
        return recipient(text)
    named = [c for c in contacts if str(c.get('name') or '').casefold() == text.casefold()]
    if len(named) > 1:
        raise ValueError(f'several contacts are called {text!r}; use their number instead')
    if named:
        return {'kind': 'contact', 'id': str(named[0]['id'])}
    raise ValueError(
        f'unknown contact {text!r}: use a number like +15551234567, a uuid, a contact name, '
        'or group:<group id or name>'
    )
