# Staged gateway TLS migration

The existing HTTP gateway remains compatible until this migration is completed. HTTP exposes the gateway secret, provider signatures and player session tokens to network observers. The source changes alone do not remove that exposure.

1. Create a DNS hostname for the VPS. Install Caddy using its official package instructions, copy `Caddyfile` to its configuration directory, and replace `gateway.example.com` with that hostname. Allow inbound TCP 80 and 443 for certificate issuance and HTTPS. Preserve SSH access before changing any firewall rules.
2. In `/etc/j777-gateway.env`, retain the existing secret and add `HOST=127.0.0.1` and `MAX_WORKERS=32`. Restart the gateway service and Caddy in a scheduled maintenance window. Configure the host/cloud firewall to deny public port 3001. Do not trust `X-Forwarded-For` as gateway authentication.
3. Set the application `GATEWAY_URL=https://<gateway-hostname>/` and deploy. Verify the health route and a non-money game catalogue request from the application. No game or wallet balance changes are needed for this check.
4. Set `GATEWAY_REQUIRE_HTTPS=true` and redeploy after the HTTPS endpoint is working. The application then fails closed if the gateway URL is changed back to HTTP. Rotate `GATEWAY_SECRET` in both environments together because the previous HTTP transport exposed it to any on-path observer. Monitor errors without logging headers or request bodies.
5. Configure perimeter connection/rate limits for the HTTPS hostname and keep the Python listener private. The relay itself has a 128 KiB body cap, 10-second socket inactivity timeout, 15-second absolute connection budget and 32-worker default. These limits bound resource use; they are not a substitute for perimeter abuse controls.

Use `caddy validate --config /etc/caddy/Caddyfile` before reload. Caddy's automatic certificate management requires working DNS and reachability. Validate cloud-firewall rules separately from the host firewall. Keep the backend listener on localhost after migration; rollback the application URL only as part of a coordinated maintenance decision.

Provider launch URLs are parsed as HTTPS URLs without embedded credentials. A hostname allowlist still requires confirmed provider game domains before activation; the repository does not assume that the API hostname also hosts every game.

## Application request limits on Vercel

The application checks a 128 KiB limit and reads signed callbacks with a 4-second body deadline; other application readers use 10 seconds. Standalone Vercel Node helpers may buffer the request before invoking the handler and expose a lazy parsed-body getter. The application preserves the restored raw stream for signature verification and never invokes that getter. Its size/deadline checks apply once the handler runs; they cannot cap memory or elapsed time already spent inside Vercel's request buffering. Keep platform request-size, duration and firewall controls enabled. `api.bodyParser: false` is retained for framework compatibility and is not relied on to disable standalone Node helpers. Do not disable Vercel helpers globally without replacing the response helpers used by the API.
