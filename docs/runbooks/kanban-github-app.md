# Kanban GitHub App operator runbook

Run the control plane (CP) and relay in App mode, per
[kanban-p0-pilot.md § M3](../designs/kanban-p0-pilot.md#m3--app-installation-tokens-and-webhook-delivery),
instead of the dev/test PAT fallback `kanbanAccessToken`.

For the pilot the App is already created and installed on
`mw-ding/agentconnect`. The create steps below are for rebuilding it or
for another board repo. Creating and installing an App is an action for
the account or org owner.

## Create the App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
For an org-owned App: org Settings → Developer settings → GitHub Apps.

Give the App a name and a homepage URL. Any URL works; use the board
repo or the deployment's public page.

Under Webhook: check Active and set the URL to the relay's
`POST /webhooks/github`. In production that is e.g.
`https://<relay-host>/webhooks/github`; behind the Caddy overlay it is
`https://<host>:<port>/relay/webhooks/github`. For dev or E2E, use a
smee.io channel forwarded to the relay instead.

Interim dev/E2E channel: `https://smee.io/wYHF8fyjxvqpq6yg`. This is a
forwarder URL, not a secret; anyone with it can read deliveries, so do
not use smee for production. Forward it to the relay:

```bash
npx smee-client --url https://smee.io/wYHF8fyjxvqpq6yg \
  --target "http://localhost:${RELAY_PORT}/webhooks/github"
```

A webhook secret is required. Generate one, e.g.
`openssl rand -hex 32`, and store it directly in the secret store.
Never paste it into chat, issues, or PRs.

## Repository permissions

| Permission    | Access           |
| ------------- | ---------------- |
| Issues        | Read & write     |
| Contents      | Read & write     |
| Pull requests | Read & write     |
| Metadata      | Read (mandatory) |

Nothing else. The CP narrows per-run installation tokens below these
(read mode vs write mode); see the design section linked above.

## Subscribe to events

Subscribe to Issues, Issue comment, and Label. Also subscribe to
Sub issues / Issue dependencies when GitHub offers them; both ride the
Issues permission.

Under "Where can this GitHub App be installed?", choose Only on this
account.

## Private key

Generate a private key on the App page. GitHub downloads a `.pem` file.
Pipe it straight into the secret store (`store-secret` stands for your
store's write command; `PEM_FILE` is the downloaded file):

```bash
base64 -w0 "$PEM_FILE" | store-secret GITHUB_APP_PRIVATE_KEY_B64
```

On macOS (`base64` has no `-w0`):

```bash
base64 -i "$PEM_FILE" | tr -d '\n' | store-secret GITHUB_APP_PRIVATE_KEY_B64
```

Delete the local `.pem` after storing it.

## Install the App

App page → Install App → choose the account → "Only select
repositories" → `mw-ding/agentconnect` (or the chosen board repo).
Confirm the repo appears under Install → Configure.

## Env / secret mapping

| Var                               | Source                                           | Consumer                                                                |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `GITHUB_APP_ID`                   | App settings → App ID                            | CP                                                                      |
| `GITHUB_APP_SLUG`                 | URL slug of the App (`github.com/apps/<slug>`)   | CP (self-comment recognition; blank fails boot)                         |
| `GITHUB_APP_PRIVATE_KEY_B64`      | "Generate a private key" → `.pem` → `base64 -w0` | CP                                                                      |
| `GITHUB_APP_WEBHOOK_SECRET`       | the webhook secret you typed                     | relay (superseded by CP `github.webhookSecret` once a snapshot arrives) |
| `GITHUB_APP_CLIENT_ID` (optional) | App settings → Client ID                         | CP (JWT issuer)                                                         |

App mode needs ID, private key, and slug together. A partial
`GITHUB_APP_*` set fails boot, and so does a blank slug; the key must
be base64 of an RSA PEM. Unset all of them → PAT fallback (dev/test
only; logged).

## Where secrets live

Production values live in the deployment secret store. Local dev uses
`.env`, which is gitignored (`.env`/`.env.*` in `.gitignore`). The E2E
uses GitHub Actions repository secrets. Secrets are never committed and
never appear in issues, PRs, chat, or logs.

Live values for the pilot App are handed off through Ash's Secure Form;
ask Ash/MD. This doc carries names only.

Rotation: regenerate the key (or change the webhook secret) in App
settings, update the store, restart CP and relay, then delete the old
key.

## Verify

1. CP boots in App mode: no "partial" error, no PAT-fallback log.
2. Installation id: mint an App JWT (RS256, `iat` = now minus 60s,
   `exp` ≤ 10 min, `iss` = Client ID or App ID). A short Node snippet
   reading the key from the `GITHUB_APP_PRIVATE_KEY_B64` env var
   (never echoing it), or any JWT tool, works. Then:

   ```bash
   curl -H "Authorization: Bearer $APP_JWT" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/mw-ding/agentconnect/installation
   ```

   `.id` in the response is the installation id. Record it on issue
   #605 (not a secret) along with the App ID and slug (also not
   secret). Never record the key or the webhook secret.

3. Ping: App settings → Advanced → Recent Deliveries → redeliver the
   `ping` (or send a test). The relay answers 204 (2xx) for a valid
   `X-Hub-Signature-256`. A 404 means the relay has no webhook secret
   configured.
4. Bad signature → 401 (nothing forwarded to CP):

   ```bash
   curl -i -X POST "${RELAY_URL}/webhooks/github" \
     -H 'Content-Type: application/json' \
     -H 'X-GitHub-Event: ping' \
     -H 'X-Hub-Signature-256: sha256=00' \
     -d '{}'
   ```

   `RELAY_URL` is the relay's public base URL. Expect HTTP 401.

5. Optional: add or remove an `ac/*` label on a card and see 202 in
   Recent Deliveries.

## Troubleshooting

- `github app config is partial — missing ... (set all three or none; ...)`: one of `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`,
  `GITHUB_APP_SLUG` is missing or the slug is blank. Set all three or
  none.
- `GITHUB_APP_PRIVATE_KEY_B64 is not valid base64`: re-encode the
  `.pem` with `base64 -w0` on one line; check for truncation or line
  breaks.
- `... must be an RSA key (got ...)`: the value is not an RSA
  private key. Generate the key from the App page and store the fresh
  `.pem`.
- 401 on every delivery: secret mismatch. The relay env secret and
  the App's webhook secret must match, and note the CP
  `github.webhookSecret` overrides the relay env once a snapshot
  arrives.
- 404 on every delivery: the relay has no webhook secret configured.
  Set `GITHUB_APP_WEBHOOK_SECRET` and restart the relay.
