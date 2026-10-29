import { generateAdminTotpSetup } from "../server/admin-mfa.mjs";

// Run privately on the operator's PC. No network calls or files are created.
const { secret } = generateAdminTotpSetup();
process.stdout.write(`
J777 admin authenticator setup

Keep this setup key private. Do not paste it into chat or a QR-code website.

In your authenticator app choose: Add account > Enter setup key
Account: J777 admin
Type: Time based (TOTP)
Setup key: ${secret}

In Vercel Production add these SERVER-ONLY environment variables:
ADMIN_TOTP_SECRET=${secret}
ADMIN_MFA_REQUIRED=true

Save a private backup of the setup key, then redeploy Production.
Keep your existing admin_secret password. No SQL migration is needed.
After deployment, /admin requires that password and the app's 6-digit code.
`);
