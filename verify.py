"""Read-only integration spike. Python 3.9+, standard library only."""
import argparse
import getpass
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, HTTPRedirectHandler, build_opener


class CheckError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    # Never forward a billing credential to a redirect target.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def number(value):
    if isinstance(value, bool) or value is None:
        raise CheckError('Provider returned a missing or invalid amount.')
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise CheckError('Provider returned an invalid amount.') from None
    if not result.is_finite():
        raise CheckError('Provider returned a non-finite amount.')
    return result


def read_api(url, token, params=None):
    if params:
        url += '?' + urlencode(params)
    request = Request(url, headers={'Authorization': 'Bearer ' + token,
                                   'Accept': 'application/json',
                                   'User-Agent': 'CreditTracker-ReadOnlyCheck/0.1'})
    try:
        with build_opener(NoRedirect).open(request, timeout=30) as response:
            payload = response.read(20_000_001)
            if len(payload) > 20_000_000:
                raise CheckError('Response exceeded the check limit; narrow the date range.')
            return payload.decode('utf-8')
    except HTTPError as error:
        # Provider error bodies can contain sensitive information. Do not log them.
        messages = {401: 'Credential rejected.', 403: 'Billing access denied; check scope and role.',
                    429: 'Rate limited; retry later.'}
        raise CheckError(messages.get(error.code, f'Provider returned HTTP {error.code}.')) from None
    except (URLError, TimeoutError):
        raise CheckError('Network request failed or timed out.') from None


def openrouter(token):
    data = json.loads(read_api('https://openrouter.ai/api/v1/credits', token))['data']
    purchased, used = number(data['total_credits']), number(data['total_usage'])
    return {'remaining': str(purchased - used), 'unit': 'USD',
            'total_credits': str(purchased), 'total_usage': str(used),
            'note': 'Calculated from provider totals; compare with dashboard before accepting.'}


def openai(token, start, end):
    totals, seen = {}, set()
    params = {'start_time': int(start.timestamp()), 'end_time': int(end.timestamp()),
              'limit': 180, 'bucket_width': '1d'}
    for _ in range(100):
        page = json.loads(read_api('https://api.openai.com/v1/organization/costs', token, params))
        for bucket in page['data']:
            for row in bucket['results']:
                amount = row['amount']
                currency = amount['currency'].upper()
                totals[currency] = totals.get(currency, Decimal(0)) + number(amount['value'])
        if page['has_more'] is False:
            return {'spend_by_currency': {k: str(v) for k, v in totals.items()},
                    'remaining': None, 'note': 'Reported spend only; wallet balance is unavailable.'}
        cursor = page['next_page']
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise CheckError('Incomplete pagination; refusing to report partial spend.')
        seen.add(cursor)
        params['page'] = cursor
    raise CheckError('Pagination limit reached; refusing to report partial spend.')


def vercel(token, team, start, end):
    payload = read_api('https://api.vercel.com/v1/billing/charges', token,
                       {'teamId': team, 'from': start.isoformat(), 'to': end.isoformat()})
    totals, count = {}, 0
    for line in payload.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        currency = row['BillingCurrency'].upper()
        totals[currency] = totals.get(currency, Decimal(0)) + number(row['BilledCost'])
        count += 1
    return {'billed_cost_by_currency': {k: str(v) for k, v in totals.items()},
            'rows': count, 'remaining': None,
            'note': 'FOCUS billed cost for the selected dates, not wallet balance or final invoice.'}


def railway(workspace):
    command = ['npx', '--yes', '--package', '@railway/cli@5.63.1', 'railway',
               'usage', '--workspace', workspace, '--json']
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        raise CheckError('Railway check needs npm and an active CLI login; it may also have timed out.') from None
    if result.returncode:
        raise CheckError('Railway usage failed. Check CLI login and workspace access.')
    data = json.loads(result.stdout)
    return {'current_usage': str(number(data['currentUsageDollars'])),
            'current_bill': str(number(data['currentBillDollars'])),
            'estimated_bill': (str(number(data['estimatedBillDollars']))
                               if data.get('estimatedBillDollars') is not None else None),
            'unit': 'USD', 'period': data['billingPeriod'], 'remaining': None,
            'note': 'Provider billing summary; credit balance is not exposed in this response.'}


def date_arg(value):
    try:
        return datetime.strptime(value, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except ValueError:
        raise argparse.ArgumentTypeError('Use YYYY-MM-DD (UTC).') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provider', choices=['all', 'openrouter', 'openai', 'vercel', 'railway',
                                            'higgsfield', 'supabase'], nargs='?', default='all')
    parser.add_argument('--prompt', action='store_true', help='Prompt locally for missing credentials; never save them.')
    parser.add_argument('--workspace', default=os.environ.get('RAILWAY_WORKSPACE_ID'))
    parser.add_argument('--team', default=os.environ.get('VERCEL_TEAM_ID'))
    parser.add_argument('--from-date', type=date_arg)
    parser.add_argument('--to-date', type=date_arg, help='Exclusive UTC end date.')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    start = args.from_date or now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = args.to_date or now
    if not start < end or (end - start).days > 365:
        parser.error('Date range must be positive and at most 365 days.')
    providers = ['openrouter', 'openai', 'higgsfield', 'railway', 'vercel', 'supabase'] if args.provider == 'all' else [args.provider]
    env_names = {'openrouter': 'OPENROUTER_MANAGEMENT_KEY', 'openai': 'OPENAI_ADMIN_KEY', 'vercel': 'VERCEL_TOKEN'}
    reports = []
    for provider in providers:
        report = {'provider': provider, 'checked_at': now.isoformat(),
                  'dashboard_reconciled': False}
        try:
            if provider in ['higgsfield', 'supabase']:
                report.update(status='research_required', note='No supported billing-read endpoint verified. No API request made.')
            elif provider == 'railway' and not args.workspace:
                report.update(status='setup_required', note='Supply --workspace or RAILWAY_WORKSPACE_ID.')
            else:
                token = None
                if provider in env_names:
                    token = os.environ.get(env_names[provider])
                    if not token and args.prompt:
                        if not sys.stdin.isatty():
                            raise CheckError('Credential prompts require an interactive terminal.')
                        token = getpass.getpass(env_names[provider] + ' (hidden, leave empty to skip): ').strip()
                    if not token:
                        report.update(status='setup_required', note='Supply ' + env_names[provider] + ' or use --prompt.')
                        reports.append(report)
                        continue
                if provider == 'vercel' and not args.team:
                    report.update(status='setup_required', note='Supply --team or VERCEL_TEAM_ID.')
                else:
                    if provider == 'openrouter':
                        metrics = openrouter(token)
                    elif provider == 'openai':
                        metrics = openai(token, start, end)
                    elif provider == 'vercel':
                        metrics = vercel(token, args.team, start, end)
                    else:
                        metrics = railway(args.workspace)
                    report.update(status='live_read_succeeded', metrics=metrics)
                    if provider in ['openai', 'vercel']:
                        report['period'] = {'start': start.isoformat(), 'end': end.isoformat(),
                                            'basis': 'selected dates; default is calendar month UTC'}
        except CheckError as error:
            report.update(status='error', note=str(error))
        except (ValueError, KeyError, TypeError, AttributeError, UnicodeError):
            report.update(status='error', note='Unexpected provider response; refusing to report an unreliable value.')
        reports.append(report)
    print(json.dumps(reports, indent=2))
    return 1 if any(r['status'] == 'error' for r in reports) else 0


if __name__ == '__main__':
    sys.exit(main())
