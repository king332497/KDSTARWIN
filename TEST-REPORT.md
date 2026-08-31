# Integration Test Report

Command: `npm test`

Result: **PASS 12/12 checks**

Verified locally against an isolated SQLite database and two independent browser-session cookie jars:

1. Two users have distinct user/session identities.
2. Canonical names remain distinct and synchronized in the Admin API.
3. Current Page changes are delivered through the Admin realtime SSE stream.
4. User A and User B chat messages are delivered realtime and never cross conversations.
5. Assist Navigation is delivered only to the selected user.
6. `BLOCKED` is rejected by backend API and the website HTML request.
7. Unblock restores access while the underlying session is still valid.
8. Terminate Session revokes the backend session.
9. Sensitive admin actions are recorded in Audit Log with admin, target, state, reason and timestamp.
10. Assist Navigation rejects routes outside the server allowlist.
11. RBAC prevents Operator/Customer Support from elevated operations.
12. Labelled sensitive chat values (e.g. OTP) are redacted before admin display.

Note: Node 22 currently prints an experimental warning for the built-in `node:sqlite` API. The test itself passes.
