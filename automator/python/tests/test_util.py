import unittest

from signal_automator import format_duration, format_recipient, parse_duration, recipient, resolve_recipient


class ParseDurationTest(unittest.TestCase):
    def test_units(self) -> None:
        cases = {
            '30s': 30,
            '10m': 600,
            '2h': 7200,
            '1d': 86400,
            '1w': 604800,
            '1h30m': 5400,
            '1h 30m': 5400,
            '1.5h': 5400,
            '90': 90,
            ' 5 min ': 300,
            '2 hours': 7200,
            '1d2h3m4s': 93784,
            '0.5s': 0.5,
            '0': 0,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_duration(text), expected)

    def test_whole_results_are_ints(self) -> None:
        self.assertIsInstance(parse_duration('1.5m'), int)
        self.assertIsInstance(parse_duration(60.0), int)
        self.assertIsInstance(parse_duration('0.5s'), float)

    def test_numbers_pass_through(self) -> None:
        self.assertEqual(parse_duration(45), 45)
        self.assertEqual(parse_duration(2.5), 2.5)

    def test_invalid(self) -> None:
        for bad in ['', 'abc', '10x', '-5s', '1h30', 'm', '5 parsecs', '1..5h']:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_duration(bad)
        with self.assertRaises(ValueError):
            parse_duration(-1)
        with self.assertRaises(TypeError):
            parse_duration(True)
        with self.assertRaises(TypeError):
            parse_duration(None)  # type: ignore[arg-type]


class FormatDurationTest(unittest.TestCase):
    def test_format(self) -> None:
        self.assertEqual(format_duration(0), '0s')
        self.assertEqual(format_duration(45), '45s')
        self.assertEqual(format_duration(600), '10m')
        self.assertEqual(format_duration(5400), '1h 30m')
        self.assertEqual(format_duration(93784), '1d 2h')
        self.assertEqual(format_duration(-90), '-1m 30s')


class RecipientTest(unittest.TestCase):
    def test_strings(self) -> None:
        self.assertEqual(recipient('+15551234567'), {'kind': 'contact', 'id': '+15551234567'})
        self.assertEqual(recipient('+1 (555) 123-4567'), {'kind': 'contact', 'id': '+15551234567'})
        self.assertEqual(recipient('group:abc=='), {'kind': 'group', 'id': 'abc=='})
        self.assertEqual(recipient('GROUP: abc=='), {'kind': 'group', 'id': 'abc=='})
        self.assertEqual(recipient('contact:+15551234567'), {'kind': 'contact', 'id': '+15551234567'})
        uuid = 'a1b2c3d4-0000-4000-8000-123456789abc'
        self.assertEqual(recipient(uuid), {'kind': 'contact', 'id': uuid})

    def test_dicts(self) -> None:
        self.assertEqual(recipient({'kind': 'group', 'id': 'x'}), {'kind': 'group', 'id': 'x'})
        with self.assertRaises(ValueError):
            recipient({'kind': 'channel', 'id': 'x'})
        with self.assertRaises(ValueError):
            recipient({'kind': 'contact', 'id': ''})

    def test_invalid(self) -> None:
        for bad in ['', '   ', 'group:']:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    recipient(bad)
        with self.assertRaises(TypeError):
            recipient(15551234567)  # type: ignore[arg-type]

    def test_resolve_names(self) -> None:
        contacts = [{'id': '+15550000001', 'name': 'Alice'}, {'id': 'uuid-b', 'name': 'Bob'}, {'id': '+2', 'name': 'bob'}]
        groups = [{'id': 'Z3JvdXAtMQ==', 'name': 'Family'}, {'id': 'dHdv', 'name': 'Work'}, {'id': 'dGhyZWU=', 'name': 'work'}]
        self.assertEqual(resolve_recipient('alice', contacts, groups), {'kind': 'contact', 'id': '+15550000001'})
        self.assertEqual(resolve_recipient('+1 555 000 0009', contacts, groups), {'kind': 'contact', 'id': '+15550000009'})
        self.assertEqual(resolve_recipient('group:family', contacts, groups), {'kind': 'group', 'id': 'Z3JvdXAtMQ=='})
        self.assertEqual(resolve_recipient('group:dHdv', contacts, groups), {'kind': 'group', 'id': 'dHdv'})
        self.assertEqual(resolve_recipient('group:unknown=', contacts, groups), {'kind': 'group', 'id': 'unknown='})
        for ambiguous in ('Bob', 'group:WORK'):
            with self.subTest(ambiguous=ambiguous):
                with self.assertRaisesRegex(ValueError, 'several'):
                    resolve_recipient(ambiguous, contacts, groups)
        with self.assertRaisesRegex(ValueError, 'unknown contact'):
            resolve_recipient('Zelda', contacts, groups)

    def test_format_recipient(self) -> None:
        self.assertEqual(format_recipient({'kind': 'group', 'id': 'abc'}), 'group:abc')
        self.assertEqual(format_recipient({'kind': 'contact', 'id': '+1555'}), '+1555')


if __name__ == '__main__':
    unittest.main()
