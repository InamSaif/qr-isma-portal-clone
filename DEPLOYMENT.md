# Deployment: domain → live app

This clone uses the **same mechanism as base IOP**.

| Piece | Value |
|---|---|
| Parent website | `e-isma.com` (ISMA site, unchanged) |
| This app | `iop.e-isma.com` (`iop.` + parent domain) |
| Public URL | `https://iop.e-isma.com` |
| Docker host port | `3017` (base IOP used `3007`) |
| App port inside container | `3000` |
| QR / view links | `https://iop.e-isma.com/view/<documentId>` |

If this clone **replaces** live IOP on the same server, keep the hostname `iop.e-isma.com` and point Nginx at this app’s port (`3017`, or change compose to `3007:3000` and proxy that).

---

## 0. What you are building

```
Phone scans QR
      │
      ▼
https://iop.e-isma.com/view/<id>
      │
      ▼
DNS A record  iop → server IP
      │
      ▼
Nginx :443  (SSL for iop.e-isma.com)
      │
      ▼
Docker app  127.0.0.1:3017  →  container :3000
      │
      ▼
MongoDB in Docker
```

`BASE_URL=https://iop.e-isma.com` is written into every new QR code. If that env is `localhost`, scanned codes will not open on phones.

---

## 1. Server

Use the same AWS Ubuntu box pattern as IOP (or a new one).

**EC2**
- Ubuntu 22.04+
- Elastic IP (static)
- Security group inbound:
  - `22` SSH (your IP)
  - `80` HTTP (anywhere)
  - `443` HTTPS (anywhere)

SSH in, then install Docker:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg nginx
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and back in so `docker` works without sudo.

```bash
docker --version
docker compose version
```

---

## 2. Domain / DNS

In the **e-isma.com** DNS zone (GoDaddy or wherever that domain is managed):

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `iop` | `<Elastic IP of this server>` | 600 |

That creates `iop.e-isma.com`.

Do **not**:
- Put a CNAME on `iop` as well
- Point `iop` at Website Builder
- Enable domain forwarding for `iop`

Leave `@` / `www` for the main ISMA site.

**Check from your laptop** (wait until this returns the Elastic IP):

```bash
dig +short iop.e-isma.com
dig @8.8.8.8 +short iop.e-isma.com
```

If this is wrong, stop. Certbot will fail.

---

## 3. Get the code on the server

```bash
sudo mkdir -p /var/www
sudo chown -R $USER:$USER /var/www
cd /var/www
git clone https://github.com/InamSaif/qr-isma-portal-clone.git qr-isma-portal
cd qr-isma-portal
```

Or copy the folder with `scp` / `rsync` if you are not pulling from GitHub.

---

## 4. App environment

```bash
cp .env.example .env
nano .env
```

Production `.env` must be:

```env
BASE_URL=https://iop.e-isma.com
```

Change `JWT_SECRET` in `docker-compose.yml` (or add it to `.env` and wire it) before going live. Default compose secret is not safe.

---

## 5. Start the app (Docker)

From `/var/www/qr-isma-portal`:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose ps
curl -I http://127.0.0.1:3017/login
```

You want `ps` showing `app` and `mongodb` healthy, and curl not connection-refused.

Logs if it fails:

```bash
docker compose logs -f app
```

**Port map**

| Service | Host port |
|---|---|
| App | `3017` |
| MongoDB | `27120` |
| Mongo Express | `8095` (optional; do not expose publicly) |

Base IOP used app port `3007`. This clone uses `3017` so both can run on one machine. If you **replace** IOP, either:

- keep `3017` and point Nginx here, or
- change compose to `"3007:3000"` and reuse the old Nginx `proxy_pass`

---

## 6. Nginx — HTTP only first (no SSL yet)

Cert files do not exist yet. If you enable the HTTPS server block now, `nginx -t` fails.

```bash
sudo mkdir -p /var/www/certbot/.well-known/acme-challenge
sudo chown -R www-data:www-data /var/www/certbot
```

Create `/etc/nginx/sites-available/qr-isma-portal` with **only this** for now:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name iop.e-isma.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:3017;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Enable it:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/qr-isma-portal /etc/nginx/sites-enabled/qr-isma-portal
sudo nginx -t && sudo systemctl reload nginx
```

If another enabled site also has `server_name iop.e-isma.com` (old IOP `qr-isma` file), disable or edit that one. Two vhosts for the same name will break certs.

**Prove ACME path is not proxied to the app:**

```bash
echo "acme-ok" | sudo tee /var/www/certbot/.well-known/acme-challenge/test-file
curl -i http://iop.e-isma.com/.well-known/acme-challenge/test-file
```

Must be `200` and body `acme-ok`.  
If you get HTML from the login page, or a `301` to HTTPS, Certbot will fail.

---

## 7. SSL certificate

```bash
sudo apt install -y certbot
sudo certbot certonly --webroot -w /var/www/certbot -d iop.e-isma.com
```

When that succeeds, certs are at:

- `/etc/letsencrypt/live/iop.e-isma.com/fullchain.pem`
- `/etc/letsencrypt/live/iop.e-isma.com/privkey.pem`

---

## 8. Nginx — HTTPS (final)

Replace `/etc/nginx/sites-available/qr-isma-portal` with the repo file:

```bash
sudo cp /var/www/qr-isma-portal/nginx/iop.e-isma.com.conf /etc/nginx/sites-available/qr-isma-portal
sudo nginx -t && sudo systemctl reload nginx
```

That file:

- HTTP `80` → ACME + redirect to HTTPS
- HTTPS `443` → proxy to `127.0.0.1:3017`
- `Host` / `X-Forwarded-Proto` forwarded so the app knows it is `https://iop.e-isma.com`

Renewal is automatic via certbot timer. Confirm:

```bash
sudo certbot renew --dry-run
```

---

## 9. Verify the live app

```bash
curl -I https://iop.e-isma.com/login
curl -I https://iop.e-isma.com/view
```

In a browser:

1. `https://iop.e-isma.com/register` — create a user
2. `https://iop.e-isma.com/dashboard` — create a permit
3. Open the generated PDF — QR must encode `https://iop.e-isma.com/view/<id>`
4. Scan with a phone (not on the same Wi‑Fi-only URL)

If the QR still shows `localhost` or `http://...:3017`, `BASE_URL` was wrong when the PDF was generated. Fix `.env` / compose, recreate the document.

---

## 10. Later updates

```bash
cd /var/www/qr-isma-portal
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Certbot `unauthorized` + HTML of the app | ACME path proxied to Node | ACME `location` **before** `location /`, webroot `/var/www/certbot` |
| Certbot `unauthorized` after HTTPS redirect | Port 443 also proxies ACME | Same ACME `location` on 80 **and** 443 |
| `nginx: cannot load certificate` | HTTPS vhost enabled before certbot | HTTP-only config first, then issue cert, then HTTPS vhost |
| `conflicting server name iop.e-isma.com` | Old IOP nginx site still enabled | Disable extra site; one `server_name` only |
| `dig` returns wrong IP | Wrong DNS zone / cache / forwarding | Authoritative nameserver must show Elastic IP |
| QR opens localhost | `BASE_URL` not public HTTPS | Set `BASE_URL=https://iop.e-isma.com` and regenerate PDF |
| App up, domain 502 | Nginx proxy port ≠ compose port | Proxy must match host port (`3017` here) |
