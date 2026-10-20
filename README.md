# NEO App Checker

A small reusable Web Service for checking private dependencies from inside a NEO App project. Redis is the first checker. The browser calls this service's HTTP API; the Node.js backend performs the private TCP connection so credentials never reach the browser.

## Redis checks

Each run performs:

1. `PING`
2. `SET` of a unique temporary key with a 30-second expiry
3. `GET` verification
4. `DEL` cleanup

The service stores no credentials or results.

## Run locally

Requires Node.js 20 or newer and a reachable Redis server.

```text
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
npm start
```

Open `http://localhost:3000`.

## Deploy on NEO App

Create a **Web Service** with:

| NEO App field | Value |
|---|---|
| Root directory | `demo-example/app-checker` |
| Build type | Dockerfile |
| Dockerfile | `Dockerfile` |
| Port | `3000` |
| Health-check path | `/readyz` |
| Public access | Enabled for browser use |
| Start command | Leave blank |

Configure these variables on the checker Web Service:

| Variable | Required | Example or default |
|---|---:|---|
| `REDIS_HOST` | Yes | Redis private hostname supplied by NEO App |
| `REDIS_PORT` | No | `6379` |
| `REDIS_PASSWORD` | Only when enabled | Store as a secret |
| `REDIS_USERNAME` | No | ACL username |
| `REDIS_TLS` | No | `false` |
| `CHECK_TIMEOUT_MS` | No | `5000` |

Do not expose the Redis Worker publicly. Keep it at one replica and use its private hostname.

## Add another checker

Add a server-side function in `server.js`, register its metadata in `GET /api/checks`, add a dedicated `POST /api/check/<id>` route, and render a new card in `public/index.html`. Keep target hosts and credentials in server-side environment variables; do not accept arbitrary hosts or secrets from the browser.

## Verification

```text
npm run check
npm test
```
