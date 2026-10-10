# @kanon/gateway

Market data for the trading screens. One process that holds the connection to
Perpl and serves every Kanon client from it.

## Why it exists

- **A browser on our domain cannot reach Perpl.** Its socket answers `403` to
  any origin but its own, and its REST API sends no CORS header. Measured
  2026-10-09 on mainnet and testnet. A server has to sit in between.
- **Perpl limits each connection** to 16 subscriptions and 10 requests a minute.
  With the gateway in front, a thousand people watching BTC cost the venue one
  subscription, not a thousand.
- **Prices do not belong in the app database.** Candles are the venue's data.
  They are read from the venue, kept in memory here for speed, and stored
  nowhere.

It holds no keys and places no orders. Everything it serves is public.

## What it serves

`GET` only, JSON, with CORS for the allowed origins. Paths and bodies are
Perpl's own, minus the `/api` prefix, so their documentation applies as is.

| Path | Kept for |
|---|---|
| `/v1/pub/context` | 15 s |
| `/v1/market-data/ticker`, `/v1/market-data/:market/ticker` | 1 s |
| `/v1/market-data/:market/book?levels=N` | 1 s |
| `/v1/market-data/:market/candles/:resolution/:from-:to` | 6 h if every candle in the range has closed, else 1 s |
| `/v1/market-data/:market/funding/:from-:to`, `/v1/market-data/funding/:from-:to` | 15 s |
| `/healthz` | not cached |

Anything else is `404`, including every trading path. Requests are validated
before they are forwarded (known market, supported resolution, at most 1024
candles), so this is not an open proxy. Timestamps are milliseconds.

A client that asks for history in windows aligned to the candle size shares
cache entries with every other client. Closed windows carry
`cache-control: public, max-age=3600`, so a CDN in front can serve them too.

### Socket

`/ws/v1/market-data`. Send Perpl's subscribe frame, get Perpl's ack:

```json
{ "mt": 5, "subs": [{ "stream": "candles@16*900", "subscribe": true }] }
{ "mt": 6, "subs": [{ "stream": "candles@16*900", "status": { "code": 0 } }] }
```

Streams: `candles@<market>*<seconds>`, `trades@<market>`, `order-book@<market>`,
`market-state@<chain>`, `funding@<chain>`, `heartbeat@<chain>`.

Every data frame is the venue's frame with one field added, `stream`, naming
the stream it belongs to. Key on that, not on `sid`. A snapshot (`mt` 11, 15,
17, or the full 9 / 10) replaces what the client holds; it is sent on
subscribing and again whenever the gateway reconnects to the venue.

A client subscribing to a stream somebody is already watching gets the current
snapshot from memory in the same instant as its ack. A stream nobody watches
stays subscribed for five minutes, so switching timeframe and back is free.

Ack codes: `0` subscribed, `404` unknown stream or market, `429` too many
subscriptions for this client or the gateway is at its stream capacity.

## Running

```
pnpm --filter @kanon/gateway start
```

| Variable | Default | |
|---|---|---|
| `PERPL_NETWORK` | `testnet` | or `mainnet` |
| `PORT` | `8787` | |
| `GATEWAY_ALLOWED_ORIGINS` | the two local dev servers | comma-separated origins, or `*` |
| `GATEWAY_WARM_STREAMS` | none | streams kept subscribed from start, e.g. `candles@16*900` |
| `GATEWAY_MAX_UPSTREAM_CONNECTIONS` | `3` | each carries 15 streams |
| `GATEWAY_LINGER_SECONDS` | `300` | |
| `FORCE_IPV4` | `false` | for hosts with broken IPv6 |

The rest are in `src/config.ts`. Logs are one JSON object per line.

- `/healthz` answers `200` while the venue connection is open and heard from in
  the last 20 seconds, `503` otherwise.
- `/livez` answers `200` whenever the process is serving. Point the host's
  health check here, so a venue outage does not get the gateway restarted.
- REST answers carry `x-kanon-cache: hit` or `miss`.

## Checking that it works

With the gateway running:

```
pnpm --filter @kanon/gateway smoke                       # the local one
pnpm --filter @kanon/gateway smoke https://<host>        # a deployed one
```

It acts as a browser tab on `http://localhost:3000` (change with `--origin`):
lists the markets, fetches history twice and confirms the second answer came
from memory, opens the socket and prints live prices for 15 seconds, then
confirms a foreign origin and a trading path are refused. Exit code 0 means
every check passed.

## Hosting

`render.yaml` at the repository root describes it as a Render web service.

It needs a host that keeps a process running and allows WebSocket connections.
A serverless function cannot hold the venue socket, and a plan that sleeps when
idle drops it. Run one instance: each instance holds its own venue connections
and its own cache, so more instances multiply the load on the venue rather than
share it.

Set `GATEWAY_ALLOWED_ORIGINS` to the origin the web app is served from, and
give the apps the gateway's address: `NEXT_PUBLIC_GATEWAY_URL` for web,
`EXPO_PUBLIC_GATEWAY_URL` for mobile. With it set, a signed-in chart and the
pair prices are read from here (`packages/ui/src/lib/market-feed.ts`). Unset,
they stay on Convex.

## Two things Perpl does that are not in its documentation

Both were found against the live venue on 2026-10-09 and both have tests.

- **The ack for `funding@<chain>` carries the wrong subscription id.** It
  repeats the id of `market-state@<chain>` (3000); funding frames arrive on
  4000. A client that routes by the acknowledged id delivers prices as funding.
  The gateway routes chain-wide frames by their type and per-market frames by
  id only when the type matches the stream.
- **A pong must arrive within about a second of the venue's ping**, or it closes
  with `1008 "ping timeout"`. On a link with a round trip near one second the
  automatic reply is too late and the connection drops every six seconds. The
  venue accepts any pong inside the window, so after the first such close the
  gateway sends pongs unprompted every 400 ms. Logged as `upstream_slow_link`.
  A normal host never triggers it.

## Not done

- No per-address rate limit on the gateway's own clients beyond a cap on
  messages per socket and a global budget of venue requests. Put it behind a
  proxy that limits by address before it takes real traffic.
- No compression on the client socket. A candle snapshot is about 23 KB.
- The order book is served at the venue's full depth; there is no thinning for
  slow clients. A client more than 1 MB behind is disconnected.
