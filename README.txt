Credit Tracker diagnostic CLI

The working dashboard and browser extension are documented in README.md.
Run the dashboard with: npm ci && npm start

The original Python checker remains useful for diagnostics (Python 3.9+, no dependencies):
  python3 verify.py
  python3 verify.py openrouter --prompt
  python3 verify.py openai --prompt
  python3 verify.py vercel --team YOUR_TEAM_ID --prompt
  python3 verify.py railway --workspace YOUR_WORKSPACE_ID

The --prompt option hides credentials and never saves them.
This diagnostic tool does not implement the browser connector or scheduled refresh;
use the dashboard for those features. Unknown values are reported as unavailable.
