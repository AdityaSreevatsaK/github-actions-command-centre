# GitHub Actions Command Centre

A lightweight, dependency-free dashboard for workflow runs across the `AdityaSreevatsaK` GitHub account. Designed to work as a GitHub Pages site or with any static web server.

## Before you begin

- A GitHub account.
- A repository for this dashboard. **This repository is public for GitHub Pages.** Only the dashboard *code* is public, never your private run data.
- To include private repositories, create a fine-grained personal access token in [GitHub Settings](https://github.com/settings/personal-access-tokens/new): resource owner `AdityaSreevatsaK`, repository access **All repositories** (or select specific repositories), repository permissions **Metadata: Read** (automatic) and **Actions: Read**. Do not give write permissions. Set an expiry. Never commit the token.

## Start locally (Windows)

1. Extract the downloaded ZIP.
2. Open **PowerShell** inside the extracted folder.
3. Run:

   ```powershell
   py -m http.server 8000
   ```

4. Open <http://localhost:8000>.
5. Click **Connect private repos** and paste the fine-grained read-only token. This step is optional if you only need public repositories.

## Publish to GitHub Pages

1. Open the [project repository](https://github.com/AdityaSreevatsaK/github-actions-command-centre).
2. The project files are already committed to `master`.
3. Open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then `master` and `/(root)`, and save.
4. Open `https://AdityaSreevatsaK.github.io/github-actions-command-centre/` after GitHub Pages has deployed. Replace the URL if you used a different repository name.
5. Connect your read-only token in the dashboard to view private runs.

Do **not** put a personal access token into repository secrets, source files, URL parameters, localStorage, sessionStorage, or a shared screenshot. The site only calls `api.github.com` using the token held in memory; reloading the page clears the token.

## How it works

- Detects all GitHub repositories owned by the account. With a token, the **All accessible** scope also includes repositories shared with the account that the token can access.
- Loads the latest **100 runs per repository** concurrently (at most five requests at a time), including their current status, time, event, branch, owner, and direct run links.
- Filters by active, failed, passed, cancelled, repository, date, and search term; active runs appear even when older than the selected date range.
- The **Monitor another account’s repository** field adds public or token-accessible repositories such as `RichardDaffern/Novel_Library`. These additions stay in the current tab only.
- Updates automatically every **2 minutes** with a token. Without a token, refresh is manual because the public GitHub API usually allows only 60 requests per hour.
- **Deep scan** requests each of GitHub's active workflow run statuses (`in_progress`, `queued`, `waiting`, `pending`, `requested`) separately, following up to 10 pages per status per repository. This helps find active runs older than the latest 100.
- Uses read-only requests throughout. No Actions can be started, cancelled or rerun from this app.
- Retains previously seen runs from repositories when a subsequent request fails and displays a warning.

### Limitations

- GitHub does **not** expose an account-wide workflow runs endpoint, so this dashboard makes one request per repository for ordinary scans. Loading many repositories can take time and consume the account's API quota.
- Each normal scan samples the 100 newest runs per repository. For exhaustive active-status coverage, use **Deep scan**. Deep scans are relatively expensive in API requests.
- The browser computes completed run duration approximately from run start and last update timestamps, and marks this with `~`.
- Static GitHub Pages is not an authentication boundary. **The page and its code are public**, even when a Pages source repository is private. Private data is only fetched inside the visitor's browser after they enter a suitable token. Use a trusted device and do not paste tokens into unknown copies of this site.
- The token is cleared by page reload and isn't saved by this application. GitHub may independently maintain normal API access logs.
- The GitHub API can restrict access depending on token selection, organisation policies and API rate limits. Repositories not selected for a fine-grained token are not visible.

## Test

Run `npm test` for the logic tests. For browser smoke tests, see `tests/browser_smoke.py` (requires Python Playwright and Chromium; tests mock GitHub API requests).

## Security

No third-party JavaScript, CDNs, trackers, analytics or service workers. Strict Content Security Policy. User and API values are rendered using `textContent`, not HTML interpolation. Token is only transmitted to `https://api.github.com` in an `Authorization` header, with no persistence.
