"""HTTP client for the Signal Automator REST API (standard library only).

Every method returns the decoded JSON exactly as the server sent it (plain
dicts and lists, camelCase keys as documented in ``automator/shared/src/index.ts``),
or ``None`` for ``204 No Content``. Failures raise :class:`AutomatorError` or
one of its subclasses.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Union

from .util import Number, needs_lookup, parse_duration, recipient, resolve_recipient

__all__ = [
    'AutomatorClient',
    'AutomatorError',
    'ServerUnavailableError',
    'ValidationError',
    'NotFoundError',
    'SendCancelledError',
    'DEFAULT_URL',
    'MATCH_TYPES',
    'default_url',
]

log = logging.getLogger('signal_automator')

DEFAULT_URL = 'http://127.0.0.1:7583'
MATCH_TYPES = ('contains', 'exact', 'startsWith', 'regex', 'word')
SCOPES = ('all', 'direct', 'groups')

RecipientLike = Union[str, Mapping[str, Any]]
Duration = Union[str, Number]

_START_HINT = (
    'Is Signal Automator running? Start it with bin/start.sh (macOS/Linux) or '
    'powershell\\Start-SignalAutomator.ps1 (Windows), or point the client at it '
    'with AUTOMATOR_URL / --url.'
)


# ---------------------------------------------------------------------- errors


class AutomatorError(Exception):
    """A failed API call.

    Attributes:
        status: HTTP status code, or None when no response was received.
        method: HTTP method of the failed request.
        url: full URL of the failed request.
        error: the server's error message (the ``error`` field of its JSON body)
            or a description of what went wrong.
        body: the decoded response body (dict, list or str) when there was one.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        method: Optional[str] = None,
        url: Optional[str] = None,
        error: Optional[str] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.method = method
        self.url = url
        self.error = error if error is not None else message
        self.body = body


class ServerUnavailableError(AutomatorError):
    """The server could not be reached (not running, wrong URL or port, timeout)."""


class ValidationError(AutomatorError):
    """400: the server rejected the request as invalid."""


class NotFoundError(AutomatorError):
    """404: unknown repeater/rule id, script name or endpoint."""


class SendCancelledError(AutomatorError):
    """409: an outgoing hook in a user script cancelled the message."""


_ERRORS_BY_STATUS = {400: ValidationError, 404: NotFoundError, 409: SendCancelledError}

_STATUS_HINTS = {
    403: 'The server only accepts requests addressed to localhost/127.0.0.1 '
    '(it checks the Host header). Use http://127.0.0.1:<port>.',
    503: 'The server failed to start; check its log output.',
}


def default_url(env: Optional[Mapping[str, str]] = None) -> str:
    """The server URL from the environment.

    ``AUTOMATOR_URL`` wins; otherwise ``http://<AUTOMATOR_HOST>:<AUTOMATOR_PORT>``
    with the server's defaults (127.0.0.1 and 7583). A wildcard bind address
    (0.0.0.0 or ::) is replaced with 127.0.0.1.
    """
    env = os.environ if env is None else env
    url = (env.get('AUTOMATOR_URL') or '').strip()
    if url:
        return url.rstrip('/')
    host = (env.get('AUTOMATOR_HOST') or '').strip() or '127.0.0.1'
    if host in ('0.0.0.0', '::', '[::]'):
        host = '127.0.0.1'
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    port = (env.get('AUTOMATOR_PORT') or '').strip() or '7583'
    return f'http://{host}:{port}'


def _segment(value: str) -> str:
    """Quote one path segment (ids and script names)."""
    if not isinstance(value, str) or not value:
        raise ValueError('id/name must be a non-empty string')
    return urllib.parse.quote(value, safe='')


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, (str, bytes)) or isinstance(value, Mapping):
        return [value]
    return list(value)


def _normalize_match(match: str) -> str:
    key = str(match).replace('_', '').replace('-', '').replace(' ', '').lower()
    for candidate in MATCH_TYPES:
        if candidate.lower() == key:
            return candidate
    raise ValueError(f"match must be one of {', '.join(MATCH_TYPES)}; got {match!r}")


def rule_action(
    *,
    reply: Optional[str] = None,
    send_to: Optional[RecipientLike] = None,
    text: Optional[str] = None,
    command: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a keyword-rule action. Give exactly one of:

    * ``reply="..."`` - answer in the conversation the message came from
    * ``send_to=..., text="..."`` - send the text to a fixed recipient
    * ``command="name"`` - run a ``bot.command(name, ...)`` handler from a script

    Reply/send texts are templates: ``{{body}} {{sender}} {{senderName}}
    {{match}} {{time}} {{date}}`` and regex groups ``{{1}}``..``{{9}}``.
    """
    given = [name for name, v in (('reply', reply), ('send_to', send_to), ('command', command)) if v is not None]
    if len(given) != 1:
        raise ValueError('give exactly one action: reply=..., send_to=... with text=..., or command=...')
    if reply is not None:
        return {'type': 'reply', 'text': reply}
    if send_to is not None:
        if text is None:
            raise ValueError('send_to=... also needs text=...')
        return {'type': 'send', 'to': recipient(send_to), 'text': text}
    return {'type': 'script', 'command': command}


# ---------------------------------------------------------------------- client


class AutomatorClient:
    """Client for one Signal Automator server.

    >>> bot = AutomatorClient()                      # AUTOMATOR_URL or http://127.0.0.1:7583
    >>> bot.send("+15551234567", "Hello from Python")
    >>> bot.create_repeater("+15551234567", "Drink some water", every="1h", max_runs=8)
    >>> bot.create_rule("opening hours", reply="We are open 9-17, Mon-Fri.")
    """

    def __init__(self, url: Optional[str] = None, timeout: float = 30.0) -> None:
        self.url = (url or default_url()).rstrip('/')
        self.timeout = timeout

    def __repr__(self) -> str:
        return f'AutomatorClient({self.url!r})'

    # ------------------------------------------------------------- transport

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """Perform one API call and return the decoded JSON (None for 204).

        ``path`` starts with ``/api``. ``body`` is JSON-encoded when given.
        """
        method = method.upper()
        url = self.url + path
        if query:
            params = {k: v for k, v in query.items() if v is not None}
            if params:
                url += '?' + urllib.parse.urlencode(params)
        headers = {'Accept': 'application/json', 'User-Agent': 'signal-automator-python'}
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json; charset=utf-8'
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            raise self._http_error(method, path, url, exc) from None
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as exc:
            reason = getattr(exc, 'reason', exc)
            raise ServerUnavailableError(
                f'Cannot reach Signal Automator at {self.url} ({reason}). {_START_HINT}',
                method=method,
                url=url,
                error=str(reason),
            ) from None
        if status == 204 or not raw:
            return None
        try:
            return json.loads(raw.decode('utf-8'))
        except ValueError:
            raise AutomatorError(
                f'{method} {path}: the server returned something that is not JSON '
                f'(is {self.url} really Signal Automator?)',
                status=status,
                method=method,
                url=url,
                body=raw.decode('utf-8', 'replace'),
            ) from None

    def _http_error(self, method: str, path: str, url: str, exc: urllib.error.HTTPError) -> AutomatorError:
        try:
            raw = exc.read()
        except OSError:
            raw = b''
        finally:
            exc.close()
        text = raw.decode('utf-8', 'replace')
        body: Any = text
        error = text.strip()
        try:
            body = json.loads(text)
            if isinstance(body, dict) and isinstance(body.get('error'), str):
                error = body['error']
        except ValueError:
            pass
        if not error:
            error = exc.reason if isinstance(exc.reason, str) else f'HTTP {exc.code}'
        message = f'{method} {path} failed with {exc.code}: {error}'
        hint = _STATUS_HINTS.get(exc.code)
        if hint:
            message += f' ({hint})'
        cls = _ERRORS_BY_STATUS.get(exc.code, AutomatorError)
        return cls(message, status=exc.code, method=method, url=url, error=error, body=body)

    def _object(self, method: str, path: str, body: Any = None, query: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """``request`` for routes that answer with a JSON object."""
        result = self.request(method, path, body, query)
        if not isinstance(result, dict):
            raise AutomatorError(
                f'{method} {path}: expected a JSON object, got {type(result).__name__}',
                method=method,
                url=self.url + path,
                body=result,
            )
        return result

    def _list(self, method: str, path: str, body: Any = None, query: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
        """``request`` for routes that answer with a JSON array of objects."""
        result = self.request(method, path, body, query)
        if not isinstance(result, list):
            raise AutomatorError(
                f'{method} {path}: expected a JSON array, got {type(result).__name__}',
                method=method,
                url=self.url + path,
                body=result,
            )
        return result

    # ------------------------------------------------------------ state etc.

    def state(self) -> Dict[str, Any]:
        """``GET /api/state``: status, contacts, groups, repeaters, rules, scripts, messages, logs."""
        return self._object('GET', '/api/state')

    def status(self) -> Dict[str, Any]:
        """``GET /api/status``: ``{kind, state, account, detail}`` of the Signal connection."""
        return self._object('GET', '/api/status')

    def contacts(self) -> List[Dict[str, Any]]:
        """Known contacts (from the state snapshot)."""
        contacts = self.state().get('contacts')
        return contacts if isinstance(contacts, list) else []

    def groups(self) -> List[Dict[str, Any]]:
        """Known groups (from the state snapshot)."""
        groups = self.state().get('groups')
        return groups if isinstance(groups, list) else []

    def find_recipient(self, text: str) -> Dict[str, str]:
        """Resolve a number, uuid, contact name, ``group:<id>`` or ``group:<name>``
        to a ``{"kind", "id"}`` recipient. Fetches the contact list only when a
        name is given. Raises ValueError for unknown or ambiguous names.

        >>> client.send(client.find_recipient('group:Family'), 'Dinner at 7')
        """
        if not needs_lookup(text):
            return recipient(text)
        state = self.state()
        return resolve_recipient(text, state.get('contacts') or [], state.get('groups') or [])

    def refresh_contacts(self) -> Dict[str, Any]:
        """``POST /api/contacts/refresh``: reload contacts and groups from signal-cli."""
        return self._object('POST', '/api/contacts/refresh')

    def messages(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """``GET /api/messages``: the message log, newest first (the server keeps 500)."""
        if limit is not None and (not isinstance(limit, int) or limit < 1):
            raise ValueError('limit must be a positive integer')
        return self._list('GET', '/api/messages', query={'limit': limit})

    def send(self, to: RecipientLike, body: str) -> Dict[str, Any]:
        """``POST /api/send``: send a message now and return the logged message.

        ``to`` is a number (``"+15551234567"``), a uuid, ``"group:<id>"`` or a
        ``{"kind", "id"}`` dict. Raises :class:`SendCancelledError` when a
        script's outgoing hook cancelled the message.
        """
        return self._object('POST', '/api/send', {'to': recipient(to), 'body': body})

    def simulate_incoming(self, sender: str, body: str, group_id: Optional[str] = None) -> None:
        """``POST /api/simulate/incoming``: feed a fake incoming message through
        keyword rules and scripts, as if ``sender`` had written ``body``.

        Nothing is received from Signal, but replies that rules or scripts send
        are real messages (unless the server runs in mock mode).
        """
        payload: Dict[str, Any] = {'from': sender, 'body': body}
        if group_id:
            payload['groupId'] = group_id[len('group:'):] if group_id.startswith('group:') else group_id
        self.request('POST', '/api/simulate/incoming', payload)

    # ------------------------------------------------------------- repeaters

    def list_repeaters(self) -> List[Dict[str, Any]]:
        """``GET /api/repeaters``."""
        return self._list('GET', '/api/repeaters')

    def get_repeater(self, repeater_id: str) -> Dict[str, Any]:
        """One repeater by id (looked up in the list; raises NotFoundError)."""
        for rep in self.list_repeaters():
            if rep.get('id') == repeater_id:
                return rep
        raise NotFoundError(f'repeater not found: {repeater_id}', status=404, error='repeater not found')

    def create_repeater(
        self,
        to: Union[RecipientLike, Sequence[RecipientLike]],
        messages: Union[str, Sequence[str]],
        every: Duration,
        *,
        name: Optional[str] = None,
        jitter: Duration = 0,
        max_runs: Optional[int] = None,
        enabled: bool = True,
    ) -> Dict[str, Any]:
        """``POST /api/repeaters``: send ``messages`` to ``to`` every ``every``.

        Args:
            to: one recipient or a list of them.
            messages: one text, or a list sent in rotation (run N sends
                ``messages[N % len(messages)]``).
            every: countdown between sends, in seconds or as "30s", "10m", "2h", "1d".
            name: shown in the UI; defaults to the start of the first message.
            jitter: random extra 0..jitter added to each pause.
            max_runs: stop (and disable) after this many sends; None = forever.
            enabled: start the countdown right away.
        """
        texts = [str(m) for m in _as_list(messages)]
        if not texts or not all(t.strip() for t in texts):
            raise ValueError('give at least one non-empty message')
        payload = {
            'name': name or _default_name(texts[0]),
            'enabled': bool(enabled),
            'recipients': [recipient(r) for r in _as_list(to)],
            'messages': texts,
            'intervalSeconds': parse_duration(every),
            'jitterSeconds': parse_duration(jitter),
            'maxRuns': max_runs,
        }
        if not payload['recipients']:
            raise ValueError('give at least one recipient')
        return self._object('POST', '/api/repeaters', payload)

    def create_repeater_raw(self, repeater_input: Mapping[str, Any]) -> Dict[str, Any]:
        """``POST /api/repeaters`` with a RepeaterInput dict in the API's own camelCase form."""
        return self._object('POST', '/api/repeaters', dict(repeater_input))

    def update_repeater(self, repeater_id: str, **changes: Any) -> Dict[str, Any]:
        """``PUT /api/repeaters/:id`` with only the given fields.

        Keyword arguments: ``name``, ``enabled``, ``to`` (or ``recipients``),
        ``messages``, ``every`` (or ``interval_seconds``), ``jitter`` (or
        ``jitter_seconds``) and ``max_runs`` (None = forever). The API's
        camelCase names are accepted too.
        """
        return self._object('PUT', f'/api/repeaters/{_segment(repeater_id)}', _repeater_patch(changes))

    def enable_repeater(self, repeater_id: str, enabled: bool = True) -> Dict[str, Any]:
        """Start (or with ``enabled=False`` stop) a repeater's countdown."""
        return self.update_repeater(repeater_id, enabled=enabled)

    def disable_repeater(self, repeater_id: str) -> Dict[str, Any]:
        """Stop a repeater's countdown without deleting it."""
        return self.update_repeater(repeater_id, enabled=False)

    def delete_repeater(self, repeater_id: str) -> None:
        """``DELETE /api/repeaters/:id``."""
        self.request('DELETE', f'/api/repeaters/{_segment(repeater_id)}')

    def run_repeater(self, repeater_id: str) -> Dict[str, Any]:
        """``POST /api/repeaters/:id/run``: send the next message now and restart the countdown."""
        return self._object('POST', f'/api/repeaters/{_segment(repeater_id)}/run')

    # ----------------------------------------------------------------- rules

    def list_rules(self) -> List[Dict[str, Any]]:
        """``GET /api/rules`` in evaluation order."""
        return self._list('GET', '/api/rules')

    def create_rule(
        self,
        pattern: str,
        *,
        reply: Optional[str] = None,
        send_to: Optional[RecipientLike] = None,
        text: Optional[str] = None,
        command: Optional[str] = None,
        action: Optional[Mapping[str, Any]] = None,
        match: str = 'contains',
        name: Optional[str] = None,
        case_sensitive: bool = False,
        scope: str = 'all',
        from_filter: Iterable[str] = (),
        cooldown: Duration = 0,
        stop_processing: bool = False,
        enabled: bool = True,
    ) -> Dict[str, Any]:
        """``POST /api/rules``: react to incoming messages that match ``pattern``.

        Give the action as ``reply="..."``, ``send_to=... text="..."``,
        ``command="name"`` (a ``bot.command`` in a script) or a raw ``action`` dict.

        Args:
            match: "contains" (default), "exact", "startsWith", "word" or "regex".
            scope: "all" (default), "direct" (1:1 chats only) or "groups".
            from_filter: only react to these sender numbers/uuids (empty = anyone).
            cooldown: minimum time between triggers per conversation ("10m", 600...).
            stop_processing: do not evaluate later rules after this one matched.
        """
        if action is None:
            action = rule_action(reply=reply, send_to=send_to, text=text, command=command)
        elif any(v is not None for v in (reply, send_to, command)):
            raise ValueError('give either action=... or reply/send_to/command, not both')
        if scope not in SCOPES:
            raise ValueError(f"scope must be one of {', '.join(SCOPES)}; got {scope!r}")
        payload = {
            'name': name or pattern,
            'enabled': bool(enabled),
            'pattern': pattern,
            'matchType': _normalize_match(match),
            'caseSensitive': bool(case_sensitive),
            'scope': scope,
            'fromFilter': [recipient(s)['id'] for s in _as_list(from_filter)],
            'action': dict(action),
            'cooldownSeconds': parse_duration(cooldown),
            'stopProcessing': bool(stop_processing),
        }
        return self._object('POST', '/api/rules', payload)

    def create_rule_raw(self, rule_input: Mapping[str, Any]) -> Dict[str, Any]:
        """``POST /api/rules`` with a KeywordRuleInput dict in the API's own camelCase form."""
        return self._object('POST', '/api/rules', dict(rule_input))

    def update_rule(self, rule_id: str, **changes: Any) -> Dict[str, Any]:
        """``PUT /api/rules/:id`` with only the given fields.

        Keyword arguments: ``name``, ``enabled``, ``pattern``, ``match``,
        ``case_sensitive``, ``scope``, ``from_filter``, ``cooldown``,
        ``stop_processing``, and the action as ``action={...}``, ``reply=...``,
        ``send_to=... text=...`` or ``command=...``. camelCase names work too.
        """
        return self._object('PUT', f'/api/rules/{_segment(rule_id)}', _rule_patch(changes))

    def enable_rule(self, rule_id: str, enabled: bool = True) -> Dict[str, Any]:
        """Turn a rule on (or with ``enabled=False`` off)."""
        return self.update_rule(rule_id, enabled=enabled)

    def disable_rule(self, rule_id: str) -> Dict[str, Any]:
        """Turn a rule off without deleting it."""
        return self.update_rule(rule_id, enabled=False)

    def delete_rule(self, rule_id: str) -> None:
        """``DELETE /api/rules/:id``."""
        self.request('DELETE', f'/api/rules/{_segment(rule_id)}')

    def reorder_rules(self, ids: Sequence[str]) -> List[Dict[str, Any]]:
        """``POST /api/rules/reorder``: ``ids`` must list every rule id exactly once."""
        return self._list('POST', '/api/rules/reorder', {'ids': list(ids)})

    def test_rules(self, body: str, sender: Optional[str] = None, group: bool = False) -> Dict[str, Any]:
        """``POST /api/rules/test``: which rules would match, and what they would send.

        Returns ``{"matches": [{"ruleId": ..., "output": ...}, ...]}``. Nothing is sent.
        """
        payload: Dict[str, Any] = {'body': body, 'group': bool(group)}
        if sender:
            payload['sender'] = sender
        return self._object('POST', '/api/rules/test', payload)

    # --------------------------------------------------------------- scripts

    def list_scripts(self) -> List[Dict[str, Any]]:
        """``GET /api/scripts``."""
        return self._list('GET', '/api/scripts')

    def get_script(self, name: str) -> Dict[str, Any]:
        """``GET /api/scripts/:name``: ``{"info": ScriptInfo, "source": "..."}``."""
        return self._object('GET', f'/api/scripts/{_segment(name)}')

    def save_script(self, name: str, source: str) -> Dict[str, Any]:
        """``PUT /api/scripts/:name``: create or overwrite a script, then (re)load it."""
        return self._object('PUT', f'/api/scripts/{_segment(name)}', {'source': source})

    put_script = save_script

    def delete_script(self, name: str) -> None:
        """``DELETE /api/scripts/:name``: unload the script and delete its file."""
        self.request('DELETE', f'/api/scripts/{_segment(name)}')

    def set_script_enabled(self, name: str, enabled: bool) -> Dict[str, Any]:
        """``POST /api/scripts/:name/enable``."""
        return self._object('POST', f'/api/scripts/{_segment(name)}/enable', {'enabled': bool(enabled)})

    def enable_script(self, name: str) -> Dict[str, Any]:
        """Enable and load a script."""
        return self.set_script_enabled(name, True)

    def disable_script(self, name: str) -> Dict[str, Any]:
        """Unload a script and keep it disabled across restarts."""
        return self.set_script_enabled(name, False)

    def reload_scripts(self) -> List[Dict[str, Any]]:
        """``POST /api/scripts/reload``: rescan the scripts folder and reload every enabled script."""
        return self._list('POST', '/api/scripts/reload')

    # --------------------------------------------------------------- polling

    def poll_messages(
        self,
        since_timestamp: Optional[Number] = None,
        interval: float = 2.0,
        *,
        limit: int = 100,
        direction: Optional[str] = None,
        retry: bool = True,
    ) -> Iterator[Dict[str, Any]]:
        """Yield messages as they appear in the log, oldest first, forever.

        Polls ``GET /api/messages`` every ``interval`` seconds (the standard
        library has no WebSocket client, so this polls instead of using /ws).

        Args:
            since_timestamp: Signal timestamp in ms since the epoch. Messages
                already in the log when polling starts are yielded only when
                they are newer than this. None (default) means "from now on";
                0 replays the last ``limit`` messages first. After the first
                poll every message that newly appears is yielded, even when its
                Signal timestamp is older (delayed deliveries).
            interval: seconds between polls.
            limit: messages fetched per poll; raise it for very busy accounts.
            direction: "incoming" or "outgoing" to yield only one kind.
            retry: keep polling (with a warning) while the server is unreachable
                instead of raising ServerUnavailableError.

        Stop it with ``break``, or run it in a thread. Example::

            for msg in client.poll_messages(direction="incoming"):
                print(msg["sender"], msg["body"])
        """
        if direction not in (None, 'incoming', 'outgoing'):
            raise ValueError("direction must be None, 'incoming' or 'outgoing'")
        cutoff = time.time() * 1000 if since_timestamp is None else float(since_timestamp)
        seen: Optional[Set[str]] = None  # ids of the previous window; None before the first poll
        failures = 0
        while True:
            try:
                batch = self.messages(limit)
            except ServerUnavailableError as exc:
                if not retry:
                    raise
                failures += 1
                if failures == 1:
                    log.warning('%s; retrying every %ss', exc, max(interval, 1.0))
                time.sleep(min(max(interval, 1.0) * failures, 30.0))
                continue
            if failures:
                log.warning('reconnected to %s', self.url)
                failures = 0
            ids = [_message_key(m) for m in batch]
            if seen is None:
                fresh = [m for m in batch if float(m.get('timestamp') or 0) > cutoff]
            else:
                fresh = [m for m, key in zip(batch, ids) if key not in seen]
                if seen and len(batch) >= limit and not seen.intersection(ids):
                    log.warning(
                        'more than %d messages arrived between two polls; some were skipped '
                        '(raise limit or lower interval)',
                        limit,
                    )
            seen = set(ids)
            fresh.sort(key=lambda m: float(m.get('timestamp') or 0))
            for msg in fresh:
                if direction is None or msg.get('direction') == direction:
                    yield msg
            time.sleep(interval)


# --------------------------------------------------------------------- helpers


def _message_key(msg: Mapping[str, Any]) -> str:
    key = msg.get('id')
    if key:
        return str(key)
    peer = msg.get('peer') or {}
    return f"{msg.get('timestamp')}-{msg.get('direction')}-{peer.get('id')}"


def _default_name(text: str) -> str:
    first_line = text.strip().splitlines()[0] if text.strip() else 'Repeater'
    return first_line if len(first_line) <= 40 else first_line[:39] + '…'


_REPEATER_KEYS = {
    'name': 'name',
    'enabled': 'enabled',
    'to': 'recipients',
    'recipients': 'recipients',
    'messages': 'messages',
    'message': 'messages',
    'every': 'intervalSeconds',
    'interval': 'intervalSeconds',
    'interval_seconds': 'intervalSeconds',
    'intervalSeconds': 'intervalSeconds',
    'jitter': 'jitterSeconds',
    'jitter_seconds': 'jitterSeconds',
    'jitterSeconds': 'jitterSeconds',
    'max_runs': 'maxRuns',
    'maxRuns': 'maxRuns',
}


def _repeater_patch(changes: Mapping[str, Any]) -> Dict[str, Any]:
    patch: Dict[str, Any] = {}
    for key, value in changes.items():
        api_key = _REPEATER_KEYS.get(key)
        if api_key is None:
            raise TypeError(f"unknown repeater field {key!r} (valid: {', '.join(sorted(_REPEATER_KEYS))})")
        if api_key == 'recipients':
            value = [recipient(r) for r in _as_list(value)]
        elif api_key == 'messages':
            value = [str(m) for m in _as_list(value)]
        elif api_key in ('intervalSeconds', 'jitterSeconds'):
            value = parse_duration(value)
        elif api_key == 'enabled':
            value = bool(value)
        patch[api_key] = value
    if not patch:
        raise ValueError('nothing to update')
    return patch


_RULE_KEYS = {
    'name': 'name',
    'enabled': 'enabled',
    'pattern': 'pattern',
    'match': 'matchType',
    'match_type': 'matchType',
    'matchType': 'matchType',
    'case_sensitive': 'caseSensitive',
    'caseSensitive': 'caseSensitive',
    'scope': 'scope',
    'from_filter': 'fromFilter',
    'fromFilter': 'fromFilter',
    'action': 'action',
    'cooldown': 'cooldownSeconds',
    'cooldown_seconds': 'cooldownSeconds',
    'cooldownSeconds': 'cooldownSeconds',
    'stop_processing': 'stopProcessing',
    'stopProcessing': 'stopProcessing',
}


def _rule_patch(changes: Mapping[str, Any]) -> Dict[str, Any]:
    changes = dict(changes)
    action_kwargs = {k: changes.pop(k) for k in ('reply', 'send_to', 'text', 'command') if k in changes}
    patch: Dict[str, Any] = {}
    if action_kwargs:
        if 'action' in changes:
            raise ValueError('give either action=... or reply/send_to/command, not both')
        patch['action'] = rule_action(**action_kwargs)
    for key, value in changes.items():
        api_key = _RULE_KEYS.get(key)
        if api_key is None:
            raise TypeError(f"unknown rule field {key!r} (valid: {', '.join(sorted(_RULE_KEYS))}, reply, send_to, text, command)")
        if api_key == 'matchType':
            value = _normalize_match(value)
        elif api_key == 'cooldownSeconds':
            value = parse_duration(value)
        elif api_key == 'fromFilter':
            value = [recipient(s)['id'] for s in _as_list(value)]
        elif api_key in ('enabled', 'caseSensitive', 'stopProcessing'):
            value = bool(value)
        elif api_key == 'scope' and value not in SCOPES:
            raise ValueError(f"scope must be one of {', '.join(SCOPES)}; got {value!r}")
        elif api_key == 'action':
            value = dict(value)
        patch[api_key] = value
    if not patch:
        raise ValueError('nothing to update')
    return patch
