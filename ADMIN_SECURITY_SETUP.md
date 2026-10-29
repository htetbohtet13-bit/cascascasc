# Enable admin authenticator verification

The admin password remains in `admin_secret`. An authenticator app supplies a
second, six-digit code; player signup and payment flows are unchanged. No SMS is
used. This deployment is staged: installing the code alone does not enable MFA.

## Setup

1. On your own Windows PC, open Command Prompt in the casino folder:

   ```bat
   cd /d C:\Users\mccns\Downloads\casino
   node scripts/setup-admin-mfa.mjs
   ```

2. In your authenticator app, add an account by entering the printed setup key.
   Use account name **J777 admin** and **Time based**. The configuration is
   SHA1, six digits, 30 seconds. Save a private backup of the setup key in your
   password manager or another secure offline location before continuing.
   Never paste the setup key into chat, a public QR service, or a VITE variable.

3. Set the two server-only variables printed by the script in Vercel Production:

   ```text
   ADMIN_TOTP_SECRET=<your generated 32-character setup key>
   ADMIN_MFA_REQUIRED=true
   ```

   Keep your existing `admin_secret`. Do not put these variables on the VPS:
   the Vercel app verifies admin logins. No additional database migration is
   needed; this uses the security tables from `neon/009_auth_security.sql`.

4. Deploy the new application version with both variables. Open `/admin`; old
   password-only admin sessions are invalid. Enter the password and current app
   code. Sign out, wait for the next code, and confirm you can sign in again.
   Missing, incorrect or reused codes must fail. Ordinary player sessions remain
   valid. A code can be used successfully only once, including across devices.

5. Enable MFA on the Vercel account that manages these variables too. Someone
   controlling that account can change the application and its security settings.
   In the project's Deployment Protection settings, use **Vercel Authentication**
   with **Standard Protection** to protect generated/old deployment URLs while
   keeping the casino's Production domains public. Verify that an old deployment
   URL requires Vercel authentication in a private browser window. Older builds
   may still accept password-only admin access against the Production database.
   Do not select All Deployments for the public casino: that would also gate
   players and provider callbacks. See [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection).

## If you cannot sign in

Use automatic date/time on the phone. Wait for a fresh code after a failed or
interrupted successful request. Only the current 30-second code and its immediate
neighbours are accepted. Ten password-verified attempts in five minutes exhaust
the shared code limit; the existing IP limit also applies. Wait for the limit to
expire rather than repeatedly retrying.

If the phone is lost, restore the saved setup key on a replacement authenticator.
If there is no backup or a device/seed was compromised, use your protected Vercel
account to generate and register a new key, replace `ADMIN_TOTP_SECRET`, rotate
`admin_secret` too, and redeploy. This invalidates old sessions. Keep
`ADMIN_MFA_REQUIRED=true`: do not recover by removing the second factor or adding
a password-only browser bypass. Missing or malformed required configuration
blocks admin access; it does not affect normal player authentication.

## Implementation and limits

- Node's built-in HMAC-SHA1 implements the fixed RFC 4226/6238 configuration;
  tests use the RFC's published test vectors, including leading-zero codes and
  times past 2038. There is no third-party QR or verification service.
- Code consumption and session registration share a short transaction. The
  existing unique key on `auth_rate_limits(scope,key_hash)` prevents replay races.
  Only an HMAC of the seed/time-step is stored; submitted codes and seeds are
  never stored in that table or included in browser responses/logs.
- Enabling or rotating the seed invalidates existing admin cookies. Turning off
  both variables deliberately restores the legacy password-only mode; keep the
  required flag enabled in Production after setup.
- Authenticator codes reduce password theft risk; they do not stop real-time
  phishing, theft of an already authenticated browser, or compromise of hosting,
  database or provider credentials. Protect the operator's PC and cloud accounts.
- Tests use an isolated PostgreSQL-compatible database, not production wallets.
  Multi-process contention and live operator phone setup still need deployment
  verification. No production transfers or bets are used to validate this change.

References: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html),
[OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
