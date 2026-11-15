# GitHub Actions Command Centre

A free, read-only dashboard to monitor workflow runs across multiple GitHub repositories. It works as a static website, without a server or runtime dependencies.

**Live site:** https://adityasreevatsak.github.io/github-actions-command-centre/

## Use the dashboard

1. Open the site.
2. Enter **your GitHub username**, then select **View account**.
3. The public preview scans up to **8 repositories** per request batch to avoid exhausting GitHub's API allowance. Select **Scan next 8 repositories** to extend coverage. The counts clearly indicate when coverage is partial.
4. Filter by status, repository, date or search term. Select a run to open it on GitHub.
5. Optionally, add another `owner/repository` to your watch list.

You do not need a token for public repositories. Without authentication, GitHub generally allows only **60 API requests per hour, shared per originating IP address**, so public mode deliberately avoids attempting to scan every repository in one request burst.

## Private repositories (optional, advanced)

To access private repositories, select **Connect read-only token** and follow the GitHub link to create a **fine-grained personal access token**.

- Set a short expiry and restrict access to the minimum repositories.
- Use **Metadata: Read** (automatic) and **Actions: Read** only, without write permissions.
- Paste the token into the connection dialogue on a website you trust. Do not share the token.
- Refreshing the page or selecting **Disconnect** clears the token and private results.
- With a token, the app may fetch up to 75 repositories per scan batch, and optional auto-refresh runs every 3 minutes.

**Security trade-off:** This is a public static website, not an OAuth login service. The token is sent directly from your browser to GitHub's API and stays in browser memory; it is never placed in URLs, browser storage, the site's hosting service or repository files. Nevertheless, anyone controlling the published JavaScript could change that behaviour. Review the open-source code and trust the hosting domain before providing credentials. For large-scale distribution, an independently reviewed GitHub App/OAuth integration is preferable to asking users to paste tokens.

## GitHub API limits and reliability

- Normal scans load the latest **100 runs per selected repository**. Deep scan (token required) searches live statuses across additional pages, and is more expensive.
- GitHub's API has primary and secondary rate limits. The dashboard reads response headers, pauses requests when throttled and indicates the reset time. Use **Scan next** after the cooldown or connect with read-only access.
- When a single repository fails, other results remain visible. Each failure appears in the expandable warnings section.
- The dashboard explicitly shows `checked/total` coverage. Partial or retained data is **not** a complete account-wide live snapshot.
- Query results are not saved. Refreshing clears them; every new tab performs its own requests.
- A static site cannot provide unlimited quota, securely hold user credentials on a server or guarantee all runs are detected without authentication and sufficient API allowance.
- The dashboard only reads GitHub data; it never starts, cancels or reruns workflows.

## Develop on Windows

**Prerequisites:** Node.js 22 or later and Python 3.

1. Open PowerShell in the repository folder.
2. Run `npm test` to execute the JavaScript logic tests.
3. Run `py -m http.server 8000` to start the dashboard locally.
4. Open http://localhost:8000 in your browser.

For additional browser tests, install Python Playwright and Chromium, then run `python tests/browser_smoke.py`. Tests use mocked GitHub responses and do not need a GitHub token.

## Publish

GitHub Pages is deployed from the `master` branch root. Changes submitted through pull requests require review and merge before publication. Tests run on both Windows and Linux in GitHub Actions. The Pages branch deployment itself is not automatically gated on these checks, so review check results before merging.

## Contribute and report issues

Bug reports and pull requests are welcome. Please include reproduction steps, expected behaviour, browser version and whether a token was connected **without sharing the token or private workflow content**. For vulnerabilities, see [SECURITY.md](SECURITY.md).

This project is not affiliated with or endorsed by GitHub. GitHub and GitHub Actions are trademarks of GitHub, Inc.

Licensed under the [MIT Licence](LICENSE).
