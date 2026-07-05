# Security Policy

## Supported Versions

Security fixes are applied to the latest release and the `main` branch.

## Reporting a Vulnerability

Do not disclose vulnerabilities in public issues or discussions. Submit reports
through GitHub's private
[security advisory form](https://github.com/Iam-jayant/InboxOS/security/advisories/new).

Include:

- A description of the vulnerability and its impact
- The affected version or commit
- Reproduction steps or a minimal proof of concept
- Any suggested mitigation

Avoid accessing data that is not yours, disrupting services, or publishing
details before maintainers have had a reasonable opportunity to investigate and
release a fix.

## Scope

Relevant reports include vulnerabilities involving:

- Authentication, authorization, and session handling
- Exposure or modification of email and account data
- Injection, cross-site scripting, and server-side request forgery
- Secret handling and cryptographic controls
- Dependency and container vulnerabilities
- Bypasses of CORS, request-size, or rate-limit controls

Reports that only describe social engineering, unsupported versions, or
third-party services without an InboxOS-specific impact are generally out of
scope.

## Automated Checks

The security workflow runs:

- Backend and frontend ESLint security rules
- High and critical dependency audits
- Gitleaks secret detection
- Trivy container scanning
- An OWASP ZAP baseline scan

The backend also uses Helmet security headers, an explicit production CORS
allowlist, request-size limits, Zod payload validation, input sanitization, and
separate IP and authenticated-user rate limits.

Last updated: July 2026
