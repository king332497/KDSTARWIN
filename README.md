# KB Bank Realtime Admin Add-on

Additive integration for the supplied landing page. The original visual layout is retained; the existing frontend-only Live Chat handler is replaced by a server-backed implementation.

## Stack
- Node.js >= 22.5 (HTTP server, no third-party runtime packages)
- SQLite via `node:sqlite`
- Server-Sent Events (SSE) for realtime server push
- HTTP JSON API for commands/messages
- HttpOnly session cookies + CSRF tokens
- RBAC: SUPER_ADMIN, OPERATOR, CUSTOMER_SUPPORT

## Run

Linux/macOS:
```bash
export KB_ADMIN_EMAIL='admin@example.local'
export KB_ADMIN_PASSWORD='use-a-strong-password-at-least-12-chars'
node server.js
```

PowerShell:
```powershell
$env:KB_ADMIN_EMAIL='admin@example.local'
$env:KB_ADMIN_PASSWORD='use-a-strong-password-at-least-12-chars'
node server.js
```

Open:
- Website: http://localhost:3000/
- Admin: http://localhost:3000/admin

The server refuses to start without `KB_ADMIN_PASSWORD` (minimum 12 characters).

## Test
```bash
npm test
```
The integration test starts an isolated server/database and verifies two separate users, canonical names, presence/current page, isolated chat, targeted Assist Navigation, backend block/unblock, session termination, and audit logging.

## Security notes
- Admin never receives password/PIN/OTP/CVV/secret-token fields because those data are not collected by this add-on.
- Chat content is redacted when it contains labelled `password`, `PIN`, `OTP`, `CVV`, `token`, `secret`, or `kode keamanan` values.
- `BLOCKED` and denied access are enforced in server middleware/API and on subsequent page requests for the same server-issued user identity cookie.
- This landing page does not contain a real end-user account login. Therefore a block is tied to the server-issued persistent user identity cookie, not to a bank/customer account. For an account-level ban resistant to cookie deletion, integrate this layer with the site's real authenticated user/account ID.
- Production deployment still requires TLS, reverse-proxy hardening, secret management, backup/retention policy, rate limiting at the edge, and external security testing.
