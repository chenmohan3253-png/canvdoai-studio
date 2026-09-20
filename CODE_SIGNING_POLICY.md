# Code signing policy

CanvDoAI Studio applies for free Open Source code signing provided by SignPath.io, certificate by SignPath Foundation.

## Scope

Only official CanvDoAI Studio release artifacts built from this public repository may be submitted for release signing. Test builds, local modifications, third-party projects, customer material, API credentials, and artifacts whose source origin cannot be verified must not be submitted.

The current Windows release artifact is the NSIS installer named `CanvDoAI-Studio-<version>-Setup.exe`. A signed release must be produced by the public GitHub Actions workflow from a tagged commit in this repository. The workflow must run on a GitHub-hosted runner and must not accept executable input from an untrusted source.

## Team roles

- Committer and reviewer: [chenmohan3253-png](https://github.com/chenmohan3253-png)
- Release approver: [chenmohan3253-png](https://github.com/chenmohan3253-png)

Until additional maintainers are appointed, the repository owner performs these roles. Contributions from other people must be reviewed before merge. Release signing requests require an explicit approval and must originate from an official version tag.

## Signing controls

- GitHub multi-factor authentication must be enabled for maintainers who can modify release workflows or approve releases.
- Release-signing workflows must use GitHub-hosted runners and SignPath origin verification.
- SignPath organization identifiers and API tokens must be stored only in GitHub encrypted secrets or environments and must never be committed.
- Release permissions follow least privilege. Pull-request workflows must not have access to release-signing credentials.
- Every release must publish its version, source tag, installer SHA-256 checksum, and installation notes.
- A signed artifact must be verified with Windows Authenticode verification before it is attached to a GitHub Release.
- A compromised credential, workflow, dependency, or release requires signing to be paused while the incident is investigated.

## Privacy

See [PRIVACY.md](PRIVACY.md). CanvDoAI Studio does not send telemetry to the project maintainers. Network requests are made only when the user explicitly configures or invokes an API provider, opens a linked web page, checks an API connection, or downloads content requested by the user.

## Security reports

Security issues must be reported through GitHub Security Advisories as described in [SECURITY.md](SECURITY.md). Do not disclose API keys, customer material, or vulnerability details in a public issue.

