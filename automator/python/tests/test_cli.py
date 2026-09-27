import contextlib
import io
import json
import time
import unittest
from typing import Optional, Tuple
from unittest import mock

from signal_automator import cli

from tests.fake_server import FakeAutomator, message, state


class CliTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeAutomator().__enter__()
        self.addCleanup(self.fake.__exit__)

    def run_cli(self, *argv: str, stdin: Optional[str] = None) -> Tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if stdin is not None:
                with mock.patch('sys.stdin', io.StringIO(stdin)):
                    code = cli.main(['--url', self.fake.url, *argv])
            else:
                code = cli.main(['--url', self.fake.url, *argv])
        return code, out.getvalue(), err.getvalue()


class StatusAndSendTest(CliTestCase):
    def test_status(self) -> None:
        self.fake.respond('GET', '/api/state', state(repeaters=[{'id': 'r', 'enabled': True}]))
        code, out, _ = self.run_cli('status')
        self.assertEqual(code, 0)
        self.assertIn('mock (connected)', out)
        self.assertIn('+15550000000', out)
        self.assertIn('Repeaters  1 (1 running)', out)

    def test_status_exit_code_when_signal_is_down(self) -> None:
        down = state(status={'kind': 'signal-cli', 'state': 'connecting', 'account': None, 'detail': 'retrying'})
        self.fake.respond('GET', '/api/state', down)
        code, out, _ = self.run_cli('status')
        self.assertEqual(code, 3)
        self.assertIn('signal-cli (connecting) - retrying', out)

    def test_server_down_is_a_friendly_error(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(['--url', 'http://127.0.0.1:9', '--timeout', '2', 'status'])
        self.assertEqual(code, 1)
        self.assertIn('error: Cannot reach Signal Automator', err.getvalue())

    def test_send_by_number_joins_words(self) -> None:
        self.fake.respond('POST', '/api/send', message(1, 'hello world', direction='outgoing'))
        code, out, _ = self.run_cli('send', '+15550000001', 'hello', 'world')
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.last.json, {'to': {'kind': 'contact', 'id': '+15550000001'}, 'body': 'hello world'})
        self.assertIn('Sent to', out)
        self.assertEqual(len(self.fake.requests), 1)  # no state lookup needed for a number

    def test_send_by_contact_name_and_group_name(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('POST', '/api/send', message(1, direction='outgoing'))
        self.assertEqual(self.run_cli('send', 'alice', 'hi')[0], 0)
        self.assertEqual(self.fake.last.json['to'], {'kind': 'contact', 'id': '+15550000001'})
        self.assertEqual(self.run_cli('send', 'group:test group', 'hi')[0], 0)
        self.assertEqual(self.fake.last.json['to'], {'kind': 'group', 'id': 'Z3JvdXAtMQ=='})
        self.assertEqual(self.run_cli('send', 'group:unknown-id==', 'hi')[0], 0)
        self.assertEqual(self.fake.last.json['to'], {'kind': 'group', 'id': 'unknown-id=='})

    def test_send_unknown_name(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        code, _, err = self.run_cli('send', 'Zelda', 'hi')
        self.assertEqual(code, 2)
        self.assertIn("unknown contact 'Zelda'", err)

    def test_send_from_stdin(self) -> None:
        self.fake.respond('POST', '/api/send', message(1, direction='outgoing'))
        code, _, _ = self.run_cli('send', '+15550000001', '-', stdin='line one\nline two\n')
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.last.json['body'], 'line one\nline two')

    def test_send_cancelled(self) -> None:
        self.fake.respond('POST', '/api/send', {'error': 'message cancelled by outgoing hook in x.js'}, 409)
        code, _, err = self.run_cli('send', '+15550000001', 'DO-NOT-SEND')
        self.assertEqual(code, 1)
        self.assertIn('cancelled by outgoing hook', err)

    def test_contacts(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        code, out, _ = self.run_cli('contacts')
        self.assertEqual(code, 0)
        self.assertIn('group:Z3JvdXAtMQ==', out)
        self.assertIn('Alice', out)
        self.fake.respond('POST', '/api/contacts/refresh', {'contacts': [], 'groups': []})
        code, out, _ = self.run_cli('--json', 'contacts', '--refresh')
        self.assertEqual(json.loads(out), {'contacts': [], 'groups': []})


class RepeatTest(CliTestCase):
    def test_repeat_add(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        created = {'id': 'r1', 'name': 'Stretch!', 'enabled': True, 'intervalSeconds': 600, 'nextRunAt': time.time() * 1000 + 600000}
        self.fake.respond('POST', '/api/repeaters', created)
        code, out, _ = self.run_cli(
            'repeat', 'add', '--to', 'Bob', '--to', '+15550000009', '--every', '10m',
            '--message', 'Stretch!', '-m', 'Walk!', '--max-runs', '5', '--jitter', '30s',
        )
        self.assertEqual(code, 0, out)
        body = self.fake.last.json
        self.assertEqual(
            body['recipients'], [{'kind': 'contact', 'id': '+15550000002'}, {'kind': 'contact', 'id': '+15550000009'}]
        )
        self.assertEqual(body['messages'], ['Stretch!', 'Walk!'])
        self.assertEqual((body['intervalSeconds'], body['maxRuns'], body['jitterSeconds']), (600, 5, 30))
        self.assertIn('Repeater r1', out)
        self.assertIn('starts in', out)

    def test_repeat_add_rejects_bad_duration(self) -> None:
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as ctx:
            cli.main(['--url', self.fake.url, 'repeat', 'add', '--to', '+1555', '--every', 'soon', '-m', 'x'])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn('invalid duration', err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(['--url', self.fake.url, 'repeat', 'add', '--to', '+1555', '--every', '0s', '-m', 'x'])

    def test_repeat_list(self) -> None:
        rep = {
            'id': 'rep-123',
            'name': 'Water',
            'enabled': True,
            'recipients': [{'kind': 'contact', 'id': '+15550000001'}, {'kind': 'group', 'id': 'Z3JvdXAtMQ=='}],
            'messages': ['Drink water'],
            'intervalSeconds': 3600,
            'jitterSeconds': 0,
            'maxRuns': 8,
            'runCount': 3,
            'nextRunAt': time.time() * 1000 + 125000,
        }
        self.fake.respond('GET', '/api/state', state(repeaters=[rep]))
        code, out, _ = self.run_cli('repeat', 'list')
        self.assertEqual(code, 0)
        self.assertIn('rep-123', out)
        self.assertIn('3/8', out)
        self.assertIn('in 2m', out)
        self.assertIn('Alice (+15550000001), Test Group', out)
        code, out, _ = self.run_cli('--json', 'repeat', 'ls')
        self.assertEqual(json.loads(out)[0]['id'], 'rep-123')

    def test_repeat_run_and_rm_by_prefix(self) -> None:
        self.fake.respond('GET', '/api/repeaters', [{'id': 'abc-1', 'name': 'A'}, {'id': 'xyz-2', 'name': 'B'}])
        self.fake.respond('POST', '/api/repeaters/abc-1/run', {'id': 'abc-1', 'enabled': True, 'nextRunAt': None})
        self.fake.respond('DELETE', '/api/repeaters/xyz-2', None, 204)
        self.assertEqual(self.run_cli('repeat', 'run', 'abc')[0], 0)
        self.assertEqual(self.fake.last.path, '/api/repeaters/abc-1/run')
        code, out, _ = self.run_cli('repeat', 'rm', 'b')  # exact name, case-insensitive
        self.assertEqual(code, 0)
        self.assertIn('Deleted repeater xyz-2 "B"', out)
        code, _, err = self.run_cli('repeat', 'stop', 'nothing')
        self.assertEqual(code, 1)
        self.assertIn('no repeater', err)


class KeywordTest(CliTestCase):
    def test_keyword_add_reply(self) -> None:
        self.fake.respond('POST', '/api/rules', {'id': 'k1', 'name': 'price', 'matchType': 'word', 'pattern': 'price'})
        code, out, _ = self.run_cli('keyword', 'add', '--pattern', 'price', '--reply', 'See {{match}}', '--match', 'word')
        self.assertEqual(code, 0)
        body = self.fake.last.json
        self.assertEqual(body['action'], {'type': 'reply', 'text': 'See {{match}}'})
        self.assertEqual((body['matchType'], body['scope'], body['cooldownSeconds']), ('word', 'all', 0))
        self.assertIn('Rule k1', out)

    def test_keyword_add_send_and_command(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('POST', '/api/rules', {'id': 'k1'})
        code, _, err = self.run_cli(
            'keyword', 'add', '--pattern', 'urgent', '--send-to', 'group:Test Group', '--text', '{{body}}',
            '--from', 'Alice', '--scope', 'direct', '--cooldown', '1h', '--stop', '--match', 'startsWith',
        )
        self.assertEqual(code, 0, err)
        body = self.fake.last.json
        self.assertEqual(body['action'], {'type': 'send', 'to': {'kind': 'group', 'id': 'Z3JvdXAtMQ=='}, 'text': '{{body}}'})
        self.assertEqual(body['fromFilter'], ['+15550000001'])
        self.assertEqual((body['scope'], body['cooldownSeconds'], body['stopProcessing']), ('direct', 3600, True))
        self.assertEqual(self.run_cli('keyword', 'add', '--pattern', '^remind', '--match', 'regex', '--command', 'remind')[0], 0)
        self.assertEqual(self.fake.last.json['action'], {'type': 'script', 'command': 'remind'})

    def test_keyword_add_argument_errors(self) -> None:
        code, _, err = self.run_cli('keyword', 'add', '--pattern', 'x', '--send-to', '+15550000001')
        self.assertEqual(code, 1)
        self.assertIn('--send-to also needs --text', err)
        code, _, err = self.run_cli('keyword', 'add', '--pattern', 'x', '--reply', 'y', '--match', 'fuzzy')
        self.assertEqual(code, 2)
        self.assertIn('match must be one of', err)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(['--url', self.fake.url, 'keyword', 'add', '--pattern', 'x'])  # no action
        self.assertEqual(self.fake.calls('POST', '/api/rules'), [])

    def test_keyword_list_and_test(self) -> None:
        rule = {
            'id': 'k1',
            'name': 'Greeting',
            'enabled': True,
            'pattern': 'hello',
            'matchType': 'word',
            'caseSensitive': False,
            'scope': 'all',
            'fromFilter': [],
            'action': {'type': 'reply', 'text': 'Hi {{senderName}}'},
            'cooldownSeconds': 600,
            'stopProcessing': False,
            'triggerCount': 4,
        }
        self.fake.respond('GET', '/api/state', state(rules=[rule]))
        self.fake.respond('GET', '/api/rules', [rule])
        code, out, _ = self.run_cli('keyword', 'list')
        self.assertEqual(code, 0)
        self.assertIn('reply: Hi {{senderName}}', out)
        self.assertIn('cooldown 10m', out)
        self.fake.respond('POST', '/api/rules/test', {'matches': [{'ruleId': 'k1', 'output': 'Hi Alice'}]})
        code, out, _ = self.run_cli('keyword', 'test', 'hello', 'there', '--sender', '+15550000001')
        self.assertEqual(code, 0)
        test_call = self.fake.calls('POST', '/api/rules/test')[-1]
        self.assertEqual(test_call.json, {'body': 'hello there', 'sender': '+15550000001', 'group': False})
        self.assertIn('Greeting: would send: Hi Alice', out)

    def test_keyword_test_no_match(self) -> None:
        self.fake.respond('POST', '/api/rules/test', {'matches': []})
        code, out, _ = self.run_cli('keyword', 'test', 'nothing')
        self.assertEqual((code, out.strip()), (1, 'No rule matches.'))


class ScriptAndSimulateTest(CliTestCase):
    def test_script_reload_list_enable(self) -> None:
        ok = {'name': '00-example-ping.js', 'enabled': True, 'loaded': True, 'error': None, 'commands': ['time'], 'updatedAt': 1}
        bad = {'name': 'broken.js', 'enabled': True, 'loaded': False, 'error': 'SyntaxError: x', 'commands': [], 'updatedAt': 1}
        self.fake.respond('POST', '/api/scripts/reload', [ok, bad])
        code, out, _ = self.run_cli('script', 'reload')
        self.assertEqual(code, 1)
        self.assertIn('Reloaded 1 of 2 script(s).', out)
        self.assertIn('broken.js: SyntaxError: x', out)
        self.fake.respond('GET', '/api/scripts', [ok, bad])
        code, out, _ = self.run_cli('script', 'list')
        self.assertIn('time', out)
        self.fake.respond('POST', '/api/scripts/00-example-ping.js/enable', dict(ok, enabled=False, loaded=False))
        code, out, _ = self.run_cli('script', 'disable', '00-example-ping')
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.last.json, {'enabled': False})
        self.assertIn('00-example-ping.js: disabled', out)

    def test_simulate(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('GET', '/api/status', {'kind': 'signal-cli', 'state': 'connected', 'account': None, 'detail': None})
        self.fake.respond('POST', '/api/simulate/incoming', None, 204)
        code, out, err = self.run_cli('simulate', '--from', 'Bob', '--group', 'Test Group', 'ping')
        self.assertEqual(code, 0, err)
        self.assertEqual(self.fake.last.json, {'from': '+15550000002', 'body': 'ping', 'groupId': 'Z3JvdXAtMQ=='})
        self.assertIn('really sent', err)


class TailTest(CliTestCase):
    def test_tail_prints_history_then_new_messages(self) -> None:
        old = message(1_000, 'old one', senderName='Alice')
        newer = message(2_000, 'reply', direction='outgoing', origin='keyword', originRef='k1')
        fresh = message(3_000, 'brand new', peer='Z3JvdXAtMQ==', sender='+15550000002')
        fresh['peer'] = {'kind': 'group', 'id': 'Z3JvdXAtMQ=='}
        failed = message(4_000, 'oops', direction='outgoing', ok=False, error='rate limited')
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('GET', '/api/messages', [newer, old])
        self.fake.respond('GET', '/api/messages', [newer, old])
        self.fake.respond('GET', '/api/messages', [failed, fresh, newer, old])
        with mock.patch('signal_automator.client.time.sleep'):
            code, out, _ = self.run_cli('tail', '--last', '2', '--exit-after', '2', '--interval', '0')
        self.assertEqual(code, 0)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 4, out)
        self.assertIn('<- Alice (+15550000001): old one', lines[0])
        self.assertIn('-> Alice (+15550000001) [keyword]: reply', lines[1])
        self.assertIn('<- Test Group / Bob (+15550000002): brand new', lines[2])
        self.assertIn('[FAILED: rate limited]', lines[3])

    def test_tail_json_lines(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('GET', '/api/messages', [])
        self.fake.respond('GET', '/api/messages', [message(10**13, 'x')])
        with mock.patch('signal_automator.client.time.sleep'):
            code, out, _ = self.run_cli('--json', 'tail', '--exit-after', '1', '--incoming')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['body'], 'x')


if __name__ == '__main__':
    unittest.main()
