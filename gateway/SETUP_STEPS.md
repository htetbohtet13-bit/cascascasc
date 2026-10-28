# J777 VPS security setup

Use these steps for the existing gateway at 162.35.31.202. Keep your current SSH window open while changing access settings. Commands marked Windows run on your PC in PowerShell. Commands marked VPS run after SSH login. Stop at any failed command and keep its output; do not continue to the next stage.

## 1. Add the gateway DNS name

In the DNS settings for j777ml.com, create:

| Setting | Value |
| --- | --- |
| Type | A |
| Name | gateway |
| Address | 162.35.31.202 |
| Proxy | DNS only during setup, if your DNS provider offers a proxy switch |

Remove an old AAAA record for this hostname if it points to an unrelated server. This adds a separate hostname; leave the main website's existing records alone.

On Windows, check that the new A record resolves to the VPS:

```powershell
Resolve-DnsName gateway.j777ml.com -Type A
```

Allow inbound TCP 80 and 443 in the VPS hosting provider's firewall, if one is configured. Preserve the existing SSH access and port 3001 during the HTTPS transition.

## 2. Check the running VPS

On Windows:

```powershell
ssh root@162.35.31.202
```

On the VPS:

```bash
systemctl status --no-pager j777-gateway
curl -fsS http://127.0.0.1:3001/health
ss -lntp
ufw status verbose
/usr/sbin/sshd -T | grep '^port '
```

The health check should return `{"ok":true}`. If ports 80 or 443 already belong to another web server, stop here and integrate with that existing server instead of installing a competing listener. Record the actual SSH port before changing firewall rules.

## 3. Install Caddy on the VPS

These are the [official Caddy Ubuntu package instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), with package confirmation enabled:

```bash
apt update
apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/j777-caddy-signing.key
gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/j777-caddy-signing.key
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install --yes caddy
```

If UFW is already active, allow HTTP and HTTPS now:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

## 4. Upload the prepared gateway files

Open another Windows PowerShell window, keeping the SSH window open:

```powershell
scp "C:\Users\mccns\Downloads\casino\gateway\Caddyfile" root@162.35.31.202:/tmp/j777-Caddyfile
scp "C:\Users\mccns\Downloads\casino\gateway\proxy.py" root@162.35.31.202:/tmp/j777-proxy.py
```

On the VPS, save the current configuration and activate the HTTPS front end:

```bash
cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-j777-https
cp -n /opt/j777-gateway/proxy.py /opt/j777-gateway/proxy.py.before-j777-https
sed 's/gateway.example.com/gateway.j777ml.com/g' /tmp/j777-Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
```

Only after validation succeeds:

```bash
systemctl enable --now caddy
systemctl reload caddy
curl -fsS https://gateway.j777ml.com/health
```

The HTTPS health check must return `{"ok":true}` with no certificate error. If it fails, inspect `journalctl -u caddy -n 50 --no-pager` and fix DNS/firewall/certificate issuance first. The original gateway remains running on port 3001 during this step.

## 5. Switch Vercel to HTTPS

In the casino project's Vercel settings, update Production environment variables:

```text
GATEWAY_URL=https://gateway.j777ml.com
GATEWAY_REQUIRE_HTTPS=true
```

Keep the existing matching GATEWAY_SECRET for this transition. Redeploy, then open the site and verify that its provider game catalogue loads. A successful health check alone does not test Vercel's secret or provider credentials. Do not proceed to close port 3001 until the application works through the HTTPS address.

## 6. Make port 3001 private

On the VPS:

```bash
cp /tmp/j777-proxy.py /opt/j777-gateway/proxy.py
python3 -m py_compile /opt/j777-gateway/proxy.py
nano /etc/j777-gateway.env
```

In that file, retain the existing secret and other settings. Set these names exactly once:

```text
HOST=127.0.0.1
MAX_WORKERS=32
```

Save with Ctrl+O, Enter, then Ctrl+X. A gateway restart briefly interrupts game launch requests; use a quiet moment.

```bash
chmod 600 /etc/j777-gateway.env
systemctl restart j777-gateway
systemctl status --no-pager j777-gateway
```

Wait until the service has started, then run:

```bash
ss -lntp | grep ':3001'
curl -fsS https://gateway.j777ml.com/health
```

The listener must show **127.0.0.1:3001**, rather than 0.0.0.0:3001 or [::]:3001. Keep port 3001 closed in the hosting provider's firewall too.

For UFW, first allow the actual SSH port reported in step 2. The following assumes it is 22; substitute the real port if it differs:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw insert 1 deny 3001/tcp
ufw default deny incoming
ufw default allow outgoing
ufw enable
ufw status numbered
```

Test another SSH connection from Windows before closing your current session. Review any other services listed by `ss -lntp` before assuming these firewall rules cover every service the VPS needs. [Ubuntu firewall documentation](https://ubuntu.com/server/docs/how-to/security/firewalls/).

## 7. Use SSH keys

On Windows PowerShell, create a dedicated key and set a passphrase when prompted. If the named file already exists, preserve it and use the existing key or choose a new filename:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\j777_vps"
Get-Content "$env:USERPROFILE\.ssh\j777_vps.pub" | ssh root@162.35.31.202 "umask 077; mkdir -p /root/.ssh; cat >> /root/.ssh/authorized_keys"
ssh -i "$env:USERPROFILE\.ssh\j777_vps" -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no root@162.35.31.202
```

Only after that final key-only login succeeds, use the VPS session to disable password-based SSH:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-j777-hardening.conf
/usr/sbin/sshd -t && systemctl reload ssh
/usr/sbin/sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```

Verify password and keyboard-interactive authentication show `no`; root login must be restricted to keys. Repeat the Windows key-only login once more before closing the old session. Keep the private key and its passphrase private. [Ubuntu OpenSSH documentation](https://ubuntu.com/server/docs/how-to/security/openssh-server/).

## 8. Updates and gateway credential rotation

Review pending updates with `apt update` and `apt list --upgradable`. Apply `apt upgrade` during a maintenance window; it can restart services. If `/var/run/reboot-required` exists, arrange a reboot using the hosting console and confirm the gateway and Caddy return afterward. The public site can remain up while gateway-dependent game launches are briefly unavailable.

After HTTPS works, rotate GATEWAY_SECRET in the VPS environment file and Vercel Production together during a maintenance window, restart the relay, and redeploy Vercel. Recheck HTTPS health and the actual provider catalogue. Do not rotate only one side and leave the two secrets different.

Keep the gateway service unprivileged and use the resource restrictions in `gateway/j777-gateway.service`. That file requires a `j777-gateway` system user/group before installation; do not overwrite a live service blindly. Verify the current unit and user first with `systemctl cat j777-gateway` and `id j777-gateway`. Installing the repo's service and checking the VPS provider's backups are separate remaining hardening tasks.
