# Walmart toy stock checker

Checks walmart.com for a toy's in-stock-for-pickup status at Walmart stores near
a ZIP code, and emails you when it finds a match. Runs on **your own Windows
machine**, not in the cloud — Walmart's bot detection reliably blocks requests
from datacenter IPs (confirmed while building this), so a real browser on your
home connection is required.

Currently configured (`config.json`) to search for **Needoh** near ZIP **27540**
within **20 miles**, checking every **2 hours** once scheduled, emailing
**scottadamblack87@gmail.com** and **trinanicoleblack86@gmail.com**.

## Important limitation

This drives walmart.com the same way a person clicking around would — there is
no official Walmart stock API. It was written without the ability to test
against the live site from the environment that built it, so **the first run
needs your supervision**: a visible Chrome window will open and step through
setting your ZIP and searching. If Walmart shows a "Robot or human?" / CAPTCHA
challenge, solve it manually in that window; the browser profile is saved in
`.wm-profile/` so it should persist across future runs.

The script now pauses and waits (up to 2 minutes) whenever it detects an
interactive challenge like "press & hold," logging a message so you know to go
solve it in the window — it no longer races ahead and types into a page that's
still covered by the challenge, which is itself a bot signal.

If a run gets hard-blocked (the log says "Walmart's bot detection blocked this
request" and the URL contains `/blocked`), Walmart has flagged that session.
Delete the `.wm-profile/` folder to start fresh with new cookies, wait a while
before retrying (Akamai blocks are often temporary), and make sure to fully
solve any challenge before the script's next step fires.

If a step can't find something it expects (Walmart changed their page layout),
the script logs a clear error and — if run with `DEBUG=1` — saves a screenshot
and HTML dump to `debug/` so you (or a future coding session) can see exactly
what the page looked like and fix the selector in `check-stock.js`.

## One-time setup

1. **Install Node.js** (LTS): https://nodejs.org/
2. Open a terminal in this folder (`scripts/walmart-stock-checker`) and run:
   ```
   npm install
   ```
   This also downloads a Chromium browser for Playwright (via `postinstall`).
3. **Generate a Gmail App Password** for the sending account
   (`scottadamblack87@gmail.com`):
   - Turn on 2-Step Verification if it isn't already: https://myaccount.google.com/security
   - Go to https://myaccount.google.com/apppasswords, create one for "Mail",
     copy the 16-character code.
4. Copy `.env.example` to `.env` and paste the app password:
   ```
   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
   ```
   `.env` is gitignored — never commit it.
5. Review `config.json` if you want to change the ZIP, radius, search terms, or
   recipients later.

## First (supervised) run

```
node check-stock.js
```

Watch the Chrome window that opens. It will:
1. Go to Walmart's store finder and enter your ZIP.
2. Collect nearby stores within the configured radius.
3. For each store, set it as the active pickup location and search each term.
4. Email you (via Gmail) if anything shows as in stock for pickup, and always
   write a line to `logs/checker.log` either way.

If it errors out, re-run with `set DEBUG=1 && node check-stock.js` (cmd) and
check the `debug/` folder for a screenshot of where it got stuck.

## Scheduling every 2 hours on Windows

A helper batch file, `run-check.bat`, `cd`s into this folder and runs the
checker, logging output to `logs\task-run.log`.

**Option A — Task Scheduler GUI:**
1. Open "Task Scheduler" → Create Task…
2. General tab: name it e.g. `Walmart Needoh Stock Checker`.
3. Triggers tab → New… → "Daily", check "Repeat task every: 2 hours", "for a
   duration of: Indefinitely".
4. Actions tab → New… → Program/script: browse to
   `run-check.bat` in this folder (use the full path).
5. Conditions/Settings tabs: uncheck "Start the task only if the computer is
   on AC power" if this is a laptop, so it still runs on battery.
6. Save.

**Option B — command line** (run once in an elevated cmd prompt, replacing the
path with this folder's actual full path):
```
schtasks /create /tn "Walmart Needoh Stock Checker" /tr "C:\full\path\to\walmart-stock-checker\run-check.bat" /sc hourly /mo 2 /st 08:00
```

Because the browser runs headed (a visible window), the task needs to run in
your logged-in session — plan on your machine being on and logged in for this
to fire.

## Notes on behavior

- **Alerts**: every run that finds a match emails you (no de-duplication), so
  you may get repeat emails while an item stays in stock.
- **Headless**: set `"headless": true` in `config.json` to run without a
  visible window once you've confirmed it works reliably — but headless
  Chrome is easier for Walmart to fingerprint and block, so headed is the
  safer default.
- **Adding more toys**: add more strings to `searchTerms` in `config.json`.
