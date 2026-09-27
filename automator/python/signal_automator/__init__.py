"""Python client for Signal Automator (standard library only).

Signal Automator runs on your own computer and sends Signal messages as you
through a signal-cli linked device. This package talks to its local REST API
(default http://127.0.0.1:7583):

    from signal_automator import AutomatorClient

    bot = AutomatorClient()
    bot.send("+15551234567", "Hello from Python")
    bot.create_repeater("group:<id>", "Stand-up in 5 minutes!", every="1d")
    bot.create_rule("price", reply="Our price list: https://example.com/prices", match="word")
    for msg in bot.poll_messages(direction="incoming"):
        print(msg["sender"], msg["body"])

Command line: ``python -m signal_automator --help``.
"""

from .client import (
    AutomatorClient,
    AutomatorError,
    DEFAULT_URL,
    MATCH_TYPES,
    NotFoundError,
    SendCancelledError,
    ServerUnavailableError,
    ValidationError,
    default_url,
    rule_action,
)
from .util import format_duration, format_recipient, parse_duration, recipient, resolve_recipient

__version__ = '0.1.0'

__all__ = [
    'AutomatorClient',
    'AutomatorError',
    'DEFAULT_URL',
    'MATCH_TYPES',
    'NotFoundError',
    'SendCancelledError',
    'ServerUnavailableError',
    'ValidationError',
    'default_url',
    'format_duration',
    'format_recipient',
    'parse_duration',
    'recipient',
    'resolve_recipient',
    'rule_action',
    '__version__',
]
