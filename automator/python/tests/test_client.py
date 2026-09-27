import itertools
import socket
import unittest
from typing import Any, Dict, List
from unittest import mock

from signal_automator import (
    AutomatorClient,
    AutomatorError,
    NotFoundError,
    SendCancelledError,
    ServerUnavailableError,
    ValidationError,
    default_url,
)

from tests.fake_server import FakeAutomator, RawBody, message, state


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


class ClientTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeAutomator().__enter__()
        self.addCleanup(self.fake.__exit__)
        self.client = AutomatorClient(self.fake.url, timeout=5)


class DefaultUrlTest(unittest.TestCase):
    def test_env(self) -> None:
        self.assertEqual(default_url({}), 'http://127.0.0.1:7583')
        self.assertEqual(default_url({'AUTOMATOR_PORT': '9000'}), 'http://127.0.0.1:9000')
        self.assertEqual(default_url({'AUTOMATOR_HOST': '0.0.0.0', 'AUTOMATOR_PORT': '1'}), 'http://127.0.0.1:1')
        self.assertEqual(default_url({'AUTOMATOR_HOST': '::1'}), 'http://[::1]:7583')
        self.assertEqual(default_url({'AUTOMATOR_URL': 'http://localhost:1234/', 'AUTOMATOR_PORT': '1'}), 'http://localhost:1234')


class StateAndSendTest(ClientTestCase):
    def test_state_status_contacts(self) -> None:
        self.fake.respond('GET', '/api/state', state())
        self.fake.respond('GET', '/api/status', {'kind': 'mock', 'state': 'connected', 'account': None, 'detail': None})
        self.assertEqual(self.client.state()['status']['kind'], 'mock')
        self.assertEqual(self.client.status()['state'], 'connected')
        self.assertEqual([c['name'] for c in self.client.contacts()], ['Alice', 'Bob'])
        self.assertEqual(self.client.groups()[0]['name'], 'Test Group')
        self.assertEqual(self.fake.requests[0].headers['accept'], 'application/json')

    def test_find_recipient(self) -> None:
        self.assertEqual(self.client.find_recipient('+15550000001'), {'kind': 'contact', 'id': '+15550000001'})
        self.assertEqual(self.fake.requests, [])  # numbers need no lookup
        self.fake.respond('GET', '/api/state', state())
        self.assertEqual(self.client.find_recipient('Bob'), {'kind': 'contact', 'id': '+15550000002'})
        self.assertEqual(self.client.find_recipient('group:Test Group'), {'kind': 'group', 'id': 'Z3JvdXAtMQ=='})
        with self.assertRaises(ValueError):
            self.client.find_recipient('Nobody')

    def test_refresh_contacts_is_a_bodiless_post(self) -> None:
        self.fake.respond('POST', '/api/contacts/refresh', {'contacts': [], 'groups': []})
        self.assertEqual(self.client.refresh_contacts(), {'contacts': [], 'groups': []})
        self.assertEqual(self.fake.last.raw, b'')
        self.assertNotIn('content-type', self.fake.last.headers)

    def test_messages_limit(self) -> None:
        self.fake.respond('GET', '/api/messages', [message(2), message(1)])
        self.assertEqual(len(self.client.messages(limit=2)), 2)
        self.assertEqual(self.fake.last.query, {'limit': ['2']})
        self.client.messages()
        self.assertEqual(self.fake.last.query, {})
        with self.assertRaises(ValueError):
            self.client.messages(limit=0)

    def test_send_to_contact(self) -> None:
        sent = message(5, 'hello', direction='outgoing')
        self.fake.respond('POST', '/api/send', sent)
        self.assertEqual(self.client.send('+1 (555) 000-0001', 'hello'), sent)
        req = self.fake.last
        self.assertEqual(req.json, {'to': {'kind': 'contact', 'id': '+15550000001'}, 'body': 'hello'})
        self.assertEqual(req.headers['content-type'], 'application/json; charset=utf-8')

    def test_send_to_group_and_unicode(self) -> None:
        self.fake.respond('POST', '/api/send', message(5, direction='outgoing'))
        self.client.send('group:Z3JvdXAtMQ==', 'café \U0001F389')
        self.assertEqual(self.fake.last.json, {'to': {'kind': 'group', 'id': 'Z3JvdXAtMQ=='}, 'body': 'café \U0001F389'})

    def test_send_cancelled_by_hook(self) -> None:
        self.fake.respond('POST', '/api/send', {'error': 'message cancelled by outgoing hook in outgoing-signature.js'}, 409)
        with self.assertRaises(SendCancelledError) as ctx:
            self.client.send('+15550000001', 'DO-NOT-SEND')
        err = ctx.exception
        self.assertEqual(err.status, 409)
        self.assertEqual(err.error, 'message cancelled by outgoing hook in outgoing-signature.js')
        self.assertIn('POST /api/send failed with 409', str(err))
        self.assertIsInstance(err, AutomatorError)

    def test_simulate_incoming(self) -> None:
        self.fake.respond('POST', '/api/simulate/incoming', None, 204)
        self.client.simulate_incoming('+15550000002', 'ping')
        self.assertEqual(self.fake.last.json, {'from': '+15550000002', 'body': 'ping'})
        self.client.simulate_incoming('+15550000002', 'hi all', group_id='group:Z3JvdXAtMQ==')
        self.assertEqual(self.fake.last.json, {'from': '+15550000002', 'body': 'hi all', 'groupId': 'Z3JvdXAtMQ=='})


class ErrorTest(ClientTestCase):
    def test_validation_error(self) -> None:
        self.fake.respond('POST', '/api/repeaters', {'error': '"name" is required'}, 400)
        with self.assertRaises(ValidationError) as ctx:
            self.client.create_repeater_raw({})
        self.assertEqual(ctx.exception.body, {'error': '"name" is required'})

    def test_not_found(self) -> None:
        with self.assertRaises(NotFoundError) as ctx:
            self.client.delete_rule('nope')
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn('/api/rules/nope', str(ctx.exception))

    def test_non_json_error_body(self) -> None:
        self.fake.respond('GET', '/api/state', RawBody('Internal meltdown'), 500)
        with self.assertRaises(AutomatorError) as ctx:
            self.client.state()
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(ctx.exception.error, 'Internal meltdown')
        self.assertNotIsInstance(ctx.exception, (ValidationError, NotFoundError, SendCancelledError))

    def test_forbidden_host_has_hint(self) -> None:
        self.fake.respond('GET', '/api/state', {'error': 'forbidden host or origin'}, 403)
        with self.assertRaises(AutomatorError) as ctx:
            self.client.state()
        self.assertIn('127.0.0.1', str(ctx.exception))

    def test_success_that_is_not_json(self) -> None:
        self.fake.respond('GET', '/api/state', RawBody('<html>hello</html>', 'text/html'))
        with self.assertRaises(AutomatorError) as ctx:
            self.client.state()
        self.assertIn('not JSON', str(ctx.exception))

    def test_server_unavailable(self) -> None:
        client = AutomatorClient(f'http://127.0.0.1:{_free_port()}', timeout=2)
        with self.assertRaises(ServerUnavailableError) as ctx:
            client.status()
        self.assertIsNone(ctx.exception.status)
        self.assertIn('Is Signal Automator running?', str(ctx.exception))


class RepeaterTest(ClientTestCase):
    def test_create_with_defaults(self) -> None:
        self.fake.respond('POST', '/api/repeaters', {'id': 'r1'})
        self.client.create_repeater('+15550000001', 'Drink water', every='1h')
        self.assertEqual(
            self.fake.last.json,
            {
                'name': 'Drink water',
                'enabled': True,
                'recipients': [{'kind': 'contact', 'id': '+15550000001'}],
                'messages': ['Drink water'],
                'intervalSeconds': 3600,
                'jitterSeconds': 0,
                'maxRuns': None,
            },
        )

    def test_create_full(self) -> None:
        self.fake.respond('POST', '/api/repeaters', {'id': 'r1'})
        self.client.create_repeater(
            ['+15550000001', 'group:Z3JvdXAtMQ==', {'kind': 'contact', 'id': 'uuid-1'}],
            ['one', 'two'],
            every='10m',
            name='Rotation',
            jitter='30s',
            max_runs=3,
            enabled=False,
        )
        body = self.fake.last.json
        self.assertEqual(
            body['recipients'],
            [
                {'kind': 'contact', 'id': '+15550000001'},
                {'kind': 'group', 'id': 'Z3JvdXAtMQ=='},
                {'kind': 'contact', 'id': 'uuid-1'},
            ],
        )
        self.assertEqual(body['messages'], ['one', 'two'])
        self.assertEqual((body['intervalSeconds'], body['jitterSeconds'], body['maxRuns']), (600, 30, 3))
        self.assertEqual((body['name'], body['enabled']), ('Rotation', False))

    def test_long_message_gives_short_default_name(self) -> None:
        self.fake.respond('POST', '/api/repeaters', {'id': 'r1'})
        self.client.create_repeater('+15550000001', 'x' * 100 + '\nsecond line', every=60)
        self.assertEqual(len(self.fake.last.json['name']), 40)

    def test_create_validates_locally(self) -> None:
        with self.assertRaises(ValueError):
            self.client.create_repeater('+15550000001', [], every='1m')
        with self.assertRaises(ValueError):
            self.client.create_repeater([], 'hi', every='1m')
        with self.assertRaises(ValueError):
            self.client.create_repeater('+15550000001', 'hi', every='soon')
        self.assertEqual(self.fake.requests, [])

    def test_update_maps_names(self) -> None:
        self.fake.respond('PUT', '/api/repeaters/id%201', {'id': 'id 1'})
        self.client.update_repeater('id 1', every='2h', jitter=5, to='group:g', message='solo', max_runs=None, enabled=0)
        self.assertEqual(self.fake.last.path, '/api/repeaters/id%201')
        self.assertEqual(
            self.fake.last.json,
            {
                'intervalSeconds': 7200,
                'jitterSeconds': 5,
                'recipients': [{'kind': 'group', 'id': 'g'}],
                'messages': ['solo'],
                'maxRuns': None,
                'enabled': False,
            },
        )
        with self.assertRaises(TypeError):
            self.client.update_repeater('x', colour='blue')
        with self.assertRaises(ValueError):
            self.client.update_repeater('x')

    def test_path_segments_are_quoted(self) -> None:
        self.fake.respond('DELETE', '/api/repeaters/a%2Fb%3F', None, 204)
        self.client.delete_repeater('a/b?')
        self.assertEqual(self.fake.last.path, '/api/repeaters/a%2Fb%3F')
        with self.assertRaises(ValueError):
            self.client.delete_repeater('')

    def test_enable_disable_delete_run_list(self) -> None:
        self.fake.respond('PUT', '/api/repeaters/r1', {'id': 'r1'})
        self.fake.respond('DELETE', '/api/repeaters/r1', None, 204)
        self.fake.respond('POST', '/api/repeaters/r1/run', {'id': 'r1', 'runCount': 1})
        self.fake.respond('GET', '/api/repeaters', [{'id': 'r1'}, {'id': 'r2'}])
        self.client.enable_repeater('r1')
        self.assertEqual(self.fake.last.json, {'enabled': True})
        self.client.disable_repeater('r1')
        self.assertEqual(self.fake.last.json, {'enabled': False})
        self.client.delete_repeater('r1')
        self.assertEqual(self.fake.last.method, 'DELETE')
        self.assertEqual(self.client.run_repeater('r1')['runCount'], 1)
        self.assertEqual(self.fake.last.raw, b'')
        self.assertEqual(self.client.get_repeater('r2'), {'id': 'r2'})
        with self.assertRaises(NotFoundError):
            self.client.get_repeater('r3')


class RuleTest(ClientTestCase):
    def test_create_reply_rule_with_defaults(self) -> None:
        self.fake.respond('POST', '/api/rules', {'id': 'k1'})
        self.client.create_rule('price', reply='Prices: {{senderName}}')
        self.assertEqual(
            self.fake.last.json,
            {
                'name': 'price',
                'enabled': True,
                'pattern': 'price',
                'matchType': 'contains',
                'caseSensitive': False,
                'scope': 'all',
                'fromFilter': [],
                'action': {'type': 'reply', 'text': 'Prices: {{senderName}}'},
                'cooldownSeconds': 0,
                'stopProcessing': False,
            },
        )

    def test_create_other_actions(self) -> None:
        self.fake.respond('POST', '/api/rules', {'id': 'k1'})
        self.client.create_rule(
            r'^remind (\d+) (.+)$',
            command='remind',
            match='regex',
            scope='direct',
            from_filter=['+1 555 000 0001'],
            cooldown='1m',
            stop_processing=True,
            case_sensitive=True,
            name='Reminders',
        )
        body = self.fake.last.json
        self.assertEqual(body['action'], {'type': 'script', 'command': 'remind'})
        self.assertEqual(body['matchType'], 'regex')
        self.assertEqual(body['fromFilter'], ['+15550000001'])
        self.assertEqual((body['cooldownSeconds'], body['stopProcessing'], body['caseSensitive']), (60, True, True))
        self.client.create_rule('urgent', send_to='group:g', text='{{senderName}}: {{body}}', match='starts_with')
        body = self.fake.last.json
        self.assertEqual(body['action'], {'type': 'send', 'to': {'kind': 'group', 'id': 'g'}, 'text': '{{senderName}}: {{body}}'})
        self.assertEqual(body['matchType'], 'startsWith')

    def test_create_rule_argument_errors(self) -> None:
        with self.assertRaises(ValueError):
            self.client.create_rule('x')  # no action
        with self.assertRaises(ValueError):
            self.client.create_rule('x', reply='a', command='b')
        with self.assertRaises(ValueError):
            self.client.create_rule('x', send_to='+1555')  # missing text
        with self.assertRaises(ValueError):
            self.client.create_rule('x', reply='a', match='fuzzy')
        with self.assertRaises(ValueError):
            self.client.create_rule('x', reply='a', scope='everywhere')
        self.assertEqual(self.fake.requests, [])

    def test_update_reorder_test_delete(self) -> None:
        self.fake.respond('PUT', '/api/rules/k1', {'id': 'k1'})
        self.fake.respond('POST', '/api/rules/reorder', [{'id': 'k2'}, {'id': 'k1'}])
        self.fake.respond('POST', '/api/rules/test', {'matches': [{'ruleId': 'k1', 'output': 'hi'}]})
        self.fake.respond('DELETE', '/api/rules/k1', None, 204)
        self.client.update_rule('k1', reply='new', match='word', cooldown='5m', enabled=False)
        self.assertEqual(
            self.fake.last.json,
            {'action': {'type': 'reply', 'text': 'new'}, 'matchType': 'word', 'cooldownSeconds': 300, 'enabled': False},
        )
        self.client.disable_rule('k1')
        self.assertEqual(self.fake.last.json, {'enabled': False})
        self.assertEqual(self.client.reorder_rules(('k2', 'k1'))[0]['id'], 'k2')
        self.assertEqual(self.fake.last.json, {'ids': ['k2', 'k1']})
        result = self.client.test_rules('hello', sender='+15550000001', group=True)
        self.assertEqual(result['matches'][0]['output'], 'hi')
        self.assertEqual(self.fake.last.json, {'body': 'hello', 'sender': '+15550000001', 'group': True})
        self.client.test_rules('hello')
        self.assertEqual(self.fake.last.json, {'body': 'hello', 'group': False})
        self.client.delete_rule('k1')
        self.assertEqual((self.fake.last.method, self.fake.last.path), ('DELETE', '/api/rules/k1'))
        with self.assertRaises(TypeError):
            self.client.update_rule('k1', colour='red')


class ScriptTest(ClientTestCase):
    def test_script_routes(self) -> None:
        info = {'name': 'away-autoreply.js', 'enabled': True, 'loaded': True, 'error': None, 'commands': [], 'updatedAt': 1}
        self.fake.respond('GET', '/api/scripts', [info])
        self.fake.respond('GET', '/api/scripts/away-autoreply.js', {'info': info, 'source': 'export default () => {}'})
        self.fake.respond('PUT', '/api/scripts/new.js', info)
        self.fake.respond('DELETE', '/api/scripts/new.js', None, 204)
        self.fake.respond('POST', '/api/scripts/away-autoreply.js/enable', info)
        self.fake.respond('POST', '/api/scripts/reload', [info])

        self.assertEqual(self.client.list_scripts(), [info])
        self.assertEqual(self.client.get_script('away-autoreply.js')['source'], 'export default () => {}')
        self.client.save_script('new.js', 'export default function setup(bot) {}')
        self.assertEqual(self.fake.last.json, {'source': 'export default function setup(bot) {}'})
        self.client.put_script('new.js', 'x')
        self.assertEqual(self.fake.last.method, 'PUT')
        self.client.delete_script('new.js')
        self.assertEqual((self.fake.last.method, self.fake.last.path), ('DELETE', '/api/scripts/new.js'))
        self.client.disable_script('away-autoreply.js')
        self.assertEqual(self.fake.last.json, {'enabled': False})
        self.client.enable_script('away-autoreply.js')
        self.assertEqual(self.fake.last.json, {'enabled': True})
        self.assertEqual(self.client.reload_scripts(), [info])
        self.assertEqual(self.fake.last.path, '/api/scripts/reload')


class PollMessagesTest(ClientTestCase):
    def test_yields_new_and_late_messages_once_in_order(self) -> None:
        m1, m2, m3, m4 = message(1000, 'old'), message(2000, 'two'), message(3000, 'three'), message(3500, 'four')
        late = message(500, 'delayed delivery', peer='+15550000002')
        self.fake.respond('GET', '/api/messages', [m2, m1])
        self.fake.respond('GET', '/api/messages', [m4, m3, m2, m1])
        self.fake.respond('GET', '/api/messages', [late, m4, m3, m2, m1])
        gen = self.client.poll_messages(since_timestamp=1500, interval=0)
        got = [m['body'] for m in itertools.islice(gen, 4)]
        self.assertEqual(got, ['two', 'three', 'four', 'delayed delivery'])
        self.assertEqual(self.fake.last.query, {'limit': ['100']})

    def test_default_starts_from_now_and_filters_direction(self) -> None:
        now_ms = 1_700_000_000_000
        old = message(now_ms - 5000, 'before start')
        new_in = message(now_ms + 1000, 'incoming')
        new_out = message(now_ms + 2000, 'outgoing', direction='outgoing')
        self.fake.respond('GET', '/api/messages', [old])
        self.fake.respond('GET', '/api/messages', [new_out, new_in, old])
        with mock.patch('signal_automator.client.time.time', return_value=now_ms / 1000):
            gen = self.client.poll_messages(interval=0, direction='incoming', limit=10)
            self.assertEqual(next(gen)['body'], 'incoming')

    def test_retries_while_server_is_down(self) -> None:
        calls: List[int] = []

        def flaky(limit: int) -> List[Dict[str, Any]]:
            calls.append(limit)
            if len(calls) < 3:
                raise ServerUnavailableError('down')
            return [message(10**13, 'back')]

        with mock.patch.object(self.client, 'messages', side_effect=flaky), mock.patch(
            'signal_automator.client.time.sleep'
        ) as sleep, self.assertLogs('signal_automator', level='WARNING'):
            self.assertEqual(next(self.client.poll_messages(interval=0))['body'], 'back')
        self.assertEqual(len(calls), 3)
        self.assertTrue(sleep.called)

    def test_no_retry_raises(self) -> None:
        with mock.patch.object(self.client, 'messages', side_effect=ServerUnavailableError('down')):
            with self.assertRaises(ServerUnavailableError):
                next(self.client.poll_messages(interval=0, retry=False))

    def test_bad_direction(self) -> None:
        with self.assertRaises(ValueError):
            next(self.client.poll_messages(direction='sideways'))


if __name__ == '__main__':
    unittest.main()
