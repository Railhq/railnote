# Deploy the sync server

Runs on the Demorail droplet at https://sync.getrailhq.com, behind Demorail's Caddy.

```bash
npm run build:web
rsync -a --delete --relative server/sync-server.mjs server/Dockerfile dist-web deploy root@your-server:/opt/railnote-sync/
ssh root@your-server 'cd /opt/railnote-sync/deploy && docker compose up -d --build'
```

Caddy (in /opt/demorail/deploy/Caddyfile, then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`):

```
sync.getrailhq.com {
	encode gzip
	request_body {
		max_size 75MB
	}
	reverse_proxy railnote-sync:8787 {
		header_up X-Real-IP {remote_host}
	}
}
```

Spaces live in the `railnote-sync_data` volume. They are encrypted on the devices, so a backup of it holds nothing readable.
