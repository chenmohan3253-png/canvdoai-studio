# Privacy policy

Last updated: 2026-09-20

CanvDoAI Studio is a desktop client. The project maintainers do not operate an analytics or telemetry collection service for the application.

## Data stored on the computer

Projects, workflow state, generated assets, resumable task records, application settings, and API configuration are stored on the user's computer. API credentials are intended to be kept in the operating system's encrypted application storage. Users are responsible for protecting their Windows account, project files, exports, and backups.

## Network transfers

The application transfers information only when the user requests a network-backed operation. Depending on the feature and the API configuration supplied by the user, transferred data may include prompts, scripts, images, compressed key frames, short low-resolution video excerpts, audio, model identifiers, task identifiers, and generation parameters.

Data is sent to the API Base URL selected or entered by the user. CanvDoAI Studio does not guarantee or control how an independent API provider stores, processes, trains on, or deletes submitted information. Before sending confidential or personal material, users must review the provider's privacy policy, data-processing terms, retention policy, geographic location, and authorization requirements.

The application may also access GitHub release links, documentation links, email links, or other web addresses after the user selects them. It does not silently upload local projects to the project maintainers.

## Video remake analysis

For video-remake analysis, the normal design is to keep the original video on the client, extract shot boundaries and compressed key frames locally, and send only the selected analysis inputs to the user-configured visual API. Features that require motion context may send short excerpts when the user starts that analysis. Temporary server-side handling and deletion depend on the selected provider.

## Retention and deletion

Local project and credential data remains on the user's computer until it is deleted by the user or removed during application-data cleanup. Remote retention is controlled by the configured API provider. Removing local data does not automatically delete information already submitted to an external provider.

## Contact and security

General contact: `chenmomo3253@gmail.com`

For security vulnerabilities, use GitHub Security Advisories as described in [SECURITY.md](SECURITY.md). Do not include API keys, customer source media, or other sensitive data in public issues.

