"""A tiny stand-in for the Signal Automator REST API, built on http.server.

It records every request and answers from canned responses, so tests can
check the exact method, path, query and JSON body the client sends.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Tuple
from urllib.parse import parse_qs, urlsplit


class Recorded:
    def __init__(self, method: str, path: str, query: Dict[str, List[str]], headers: Dict[str, str], raw: bytes):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.raw = raw

    @property
    def json(self) -> Any:
        return json.loads(self.raw.decode('utf-8')) if self.raw else None

    def __repr__(self) -> str:
        return f'<{self.method} {self.path} {self.raw[:80]!r}>'


class RawBody:
    """A non-JSON response body."""

    def __init__(self, text: str, content_type: str = 'text/plain') -> None:
        self.text = text
        self.content_type = content_type


class FakeAutomator:
    def __init__(self) -> None:
        self.requests: List[Recorded] = []
        self._routes: Dict[Tuple[str, str], List[Tuple[int, Any]]] = {}
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, format: str, *args: Any) -> None:  # keep test output clean
                pass

            def _handle(self) -> None:
                parts = urlsplit(self.path)
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b''
                rec = Recorded(
                    self.command,
                    parts.path,
                    parse_qs(parts.query),
                    {k.lower(): v for k, v in self.headers.items()},
                    raw,
                )
                status, body = fake._next(rec)
                if status == 204:
                    self.send_response(204)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if isinstance(body, RawBody):
                    data = body.text.encode('utf-8')
                    ctype = body.content_type
                else:
                    data = json.dumps(body).encode('utf-8')
                    ctype = 'application/json; charset=utf-8'
                self.send_response(status)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self._thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)

    def __enter__(self) -> 'FakeAutomator':
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()

    def respond(self, method: str, path: str, body: Any = None, status: int = 200) -> 'FakeAutomator':
        """Queue a response. The last queued response for a route is repeated forever."""
        with self._lock:
            self._routes.setdefault((method.upper(), path), []).append((status, body))
        return self

    def _next(self, rec: Recorded) -> Tuple[int, Any]:
        with self._lock:
            self.requests.append(rec)
            queue = self._routes.get((rec.method, rec.path))
            if not queue:
                return 404, {'error': f'no such endpoint: {rec.method} {rec.path}'}
            return queue.pop(0) if len(queue) > 1 else queue[0]

    @property
    def last(self) -> Recorded:
        if not self.requests:
            raise AssertionError('no request was made')
        return self.requests[-1]

    def calls(self, method: str, path: str) -> List[Recorded]:
        return [r for r in self.requests if r.method == method and r.path == path]


def message(ts: int, body: str = 'hi', direction: str = 'incoming', peer: str = '+15550000001', **extra: Any) -> Dict[str, Any]:
    msg = {
        'id': f'{ts}-{direction}-{peer}',
        'direction': direction,
        'timestamp': ts,
        'peer': {'kind': 'contact', 'id': peer},
        'body': body,
    }
    if direction == 'incoming':
        msg['sender'] = peer
    else:
        msg.update({'origin': 'manual', 'ok': True})
    msg.update(extra)
    return msg


def state(**overrides: Any) -> Dict[str, Any]:
    base = {
        'status': {'kind': 'mock', 'state': 'connected', 'account': '+15550000000', 'detail': None},
        'contacts': [
            {'id': '+15550000001', 'number': '+15550000001', 'name': 'Alice'},
            {'id': '+15550000002', 'number': '+15550000002', 'name': 'Bob'},
        ],
        'groups': [{'id': 'Z3JvdXAtMQ==', 'name': 'Test Group', 'memberCount': 3}],
        'repeaters': [],
        'rules': [],
        'scripts': [],
        'messages': [],
        'logs': [],
    }
    base.update(overrides)
    return base
