# Black-box beta readiness report

Date: 2026-10-14 (Asia/Manila)

## Release decision

**Automated release gate: PASS**

The application is ready for supervised black-box beta testing. The only remaining hardware action is a person placing a finger on the connected scanner to confirm a fresh physical capture immediately before the session. The automated checks confirm that the real ZKTeco ZK9500 is detected, the fingerprint service is running, and simulation is disabled.

Run the complete release gate with:

```powershell
npm run beta:check
```

## Evidence

- Regression suite: 155 passed, 0 failed.
- Production dependency audit: 0 known vulnerabilities.
- Web and MariaDB containers: healthy.
- Production and fallback fingerprint container images: build successfully.
- Authentication: unauthenticated analytics rejected; configured super-admin login, session, and logout passed.
- Live data APIs: 91 applicant records and 308 criminal records were available during the check.
- Analytics: biometric evaluation status `ready`; applicant and criminal analytics endpoints passed.
- Fingerprint hardware: ZKTeco ZK9500 detected through the real Windows adapter; simulation disabled.
- Fingerprint engines: Modified Bozorth3, SourceAFIS, OpenAFIS, MCC, and Jiang Matcher returned independent live results.
- Modified Bozorth3 calibration sample: genuine score 32, impostor score 8, separation 24.
- Protected workflows: history, criminal list, notifications, comparisons, and research dataset endpoints passed.
- Browser checks: login, access guards, admin authentication overlay, desktop layout, mobile layout, accessibility labels, and console output passed.

## Release blockers fixed

- Updated the live verifier to use the correct `Modified Bozorth3` algorithm contract.
- Bounded SourceAFIS processing to prevent repeated 30-second timeouts on unusable images.
- Treated intentional low-quality-image rejection as an explicit, testable outcome.
- Rejected empty Bozorth3 templates before native execution and removed internal file paths from operator errors.
- Made the calibrated quality verifier locate its validated dataset deterministically.
- Updated Express, Sharp, and transitive dependencies to clear the production security audit.
- Added a PowerShell 5.1-compatible authenticated smoke test and one-command beta release gate.
- Replaced route-specific login copy with wording that applies to every protected workspace.

## Supervised opening checklist

1. Run `npm run beta:check` and confirm `BETA RELEASE GATE: PASS`.
2. Place a clean finger on the ZKTeco scanner and perform one fresh capture.
3. Submit one clearly labeled synthetic applicant record, review its comparison, then remove it after the session if data-retention rules permit.
4. Confirm the expected result appears in Admin Analytics and application history.

The supervised steps intentionally avoid unattended creation or deletion of persistent applicant or criminal records.
