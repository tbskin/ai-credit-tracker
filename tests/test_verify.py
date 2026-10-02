import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
import verify


class BillingChecks(unittest.TestCase):
    start = datetime(2026, 9, 1, tzinfo=timezone.utc)
    end = datetime(2026, 10, 1, tzinfo=timezone.utc)

    @patch('verify.read_api')
    def test_balance_uses_decimal_and_preserves_negative(self, read):
        read.return_value = '{"data":{"total_credits":0.1,"total_usage":0.3}}'
        self.assertEqual(verify.openrouter('test')['remaining'], '-0.2')

    @patch('verify.read_api')
    def test_costs_paginate_and_keep_currencies_separate(self, read):
        def page(currency, value, more, cursor):
            return json.dumps({'data': [{'results': [{'amount': {'currency': currency, 'value': value}}]}],
                               'has_more': more, 'next_page': cursor})
        read.side_effect = [page('usd', 1.2, True, 'next'), page('eur', 3, False, None)]
        result = verify.openai('test', self.start, self.end)
        self.assertEqual(result['spend_by_currency'], {'USD': '1.2', 'EUR': '3'})
        self.assertIsNone(result['remaining'])
        self.assertEqual(read.call_count, 2)

    @patch('verify.read_api')
    def test_incomplete_pagination_never_reports_partial_total(self, read):
        read.return_value = '{"data":[],"has_more":true,"next_page":null}'
        with self.assertRaises(verify.CheckError):
            verify.openai('test', self.start, self.end)

    @patch('verify.read_api')
    def test_vercel_includes_adjustments_without_mixing_currencies(self, read):
        read.return_value = '\n'.join(json.dumps(row) for row in [
            {'BilledCost': '10', 'BillingCurrency': 'USD'},
            {'BilledCost': '-2', 'BillingCurrency': 'USD'},
            {'BilledCost': '4', 'BillingCurrency': 'EUR'}])
        result = verify.vercel('test', 'team', self.start, self.end)
        self.assertEqual(result['billed_cost_by_currency'], {'USD': '8', 'EUR': '4'})

    def test_invalid_amounts_never_become_zero(self):
        for value in [None, True, 'NaN', 'Infinity', 'unknown']:
            with self.subTest(value=value), self.assertRaises(verify.CheckError):
                verify.number(value)

    def test_redirects_never_forward_credentials(self):
        self.assertIsNone(verify.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.com'))


if __name__ == '__main__':
    unittest.main()
