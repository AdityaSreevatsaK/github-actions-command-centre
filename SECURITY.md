# Security policy

This is a browser-only dashboard hosted on a public website. It is not a GitHub OAuth client and does not have a server-side session or token vault.

## Credentials

- Use only fine-grained, read-only tokens with the smallest possible repository selection and a short expiry.
- Tokens are held only in the active tab's memory. They are sent solely as an Authorization header to `https://api.github.com`.
- Do not put credentials in URLs, browser storage, issue reports, screenshots, logs or this repository.
- Reload the tab or select Disconnect to discard the token. Revoke a token in GitHub Settings if you suspect exposure.
- Never use this site with a token unless you trust its published domain and code. As with any static application, a compromised deployment could read credentials typed into that application.

## Reporting vulnerabilities

Please use GitHub's private vulnerability reporting feature, if enabled for this repository. Do not create a public issue containing exploitable details, sensitive tokens or private repository information.

## Known limits

- A meta-tag Content Security Policy helps reduce browser attack surface but cannot set certain server-side directives such as `frame-ancestors`; these need an HTTP response header from the hosting platform.
- GitHub API quotas are shared according to GitHub's rules and cannot be bypassed by this frontend.
- The static client has no persistent server-side access controls, alerting, audit logs or production incident monitoring.
