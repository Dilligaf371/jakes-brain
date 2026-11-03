# Claude connector

Claude can read and change Jake's Brain the same way it works with Notion: as a **custom
connector** (a remote MCP server) that you sign in to. The server is in
`server/apps/connector.js`, the sign-in in `server/apps/_connector_auth.js`. These files put it on
the internet.

```
Claude (app / claude.ai / Claude Code)
   │  https://<public address>/mcp, with a token from signing in
   ▼
tunnel (ngrok or Cloudflare) ── runs on the PC as jakes-brain-tunnel.service
   │
   ▼
127.0.0.1:4801  connector: sign-in pages + POST /mcp, 401 without a token, 404 for the rest
   │  loopback
   ▼
127.0.0.1:4800  the normal app API (stays LAN + tailnet only)
```

The address holds no secret. Nothing gets in without your password, which you set in
**Settings → Claude connector**. The password can only be set from the private app, never from
the public side. Five wrong tries lock sign-in for 15 minutes, doubling up to a day; setting the
password clears the lock. **Sign everything out** (or changing the password) cuts Claude off
immediately. Signing in lasts 90 days from Claude's last use.

## One-time setup (from the Mac)

Pick one tunnel:

- **ngrok** (free, no domain needed). Sign up at ngrok.com, copy your **authtoken**
  (Getting Started → Your Authtoken) and your free **static domain**
  (Universal Gateway → Domains, something like `jake-brain.ngrok-free.app`). Then:

  ```bash
  deploy/connector/setup-connector.sh ngrok <authtoken> <name>.ngrok-free.app
  ```

- **Cloudflare Tunnel** (free, needs a domain on Cloudflare). In the Cloudflare dashboard go to
  Zero Trust → Networks → Tunnels and create a tunnel. Add a public hostname such as
  `brain.yourdomain.com` that points to service `http://localhost:4801`, then copy the tunnel
  token:

  ```bash
  deploy/connector/setup-connector.sh cloudflare <tunnel-token> brain.yourdomain.com
  ```

The script prints the connector address. The same address appears in **Jake's Brain → Settings →
Claude connector**, with a Copy button. Set your password there.

## Add it to Claude

- **Claude app / claude.ai:** Customize → Connectors → Add → Add custom connector. Name it
  `Jake's Brain`, paste the address, and sign in with your password when it asks. It then works in
  every chat, on the phone too.
- **Claude Code:** `claude mcp add --transport http jakes-brain <address>`, then `/mcp` to sign in.

On the free ngrok plan a browser sees ngrok's own warning page once before the sign-in page: click
**Visit Site**. Claude's own requests never see it.

Then just talk to it: "log 4 eggs and PB toast for breakfast", "what have I eaten today",
"set my goal to 2400 calories and 180 g protein", "add a habit", "what did I lift last week".

Claude can do everything in the app. It reads the running app's routes and each module's header
comment, so a feature you add through GitHub is available as soon as it deploys, with no change
here and no need to reconnect. Only file uploads have to be done in the app.

## Moving the Notion history over

Ask Claude, with both the Notion and Jake's Brain connectors on: *"Copy every row of my Notion
Macros & Calories Tracker into Jake's Brain with food_log. Use each page's URL as ext_id."* The
`ext_id` makes this safe to repeat, because rows that were already copied are skipped.

## Checking on it (on the PC)

```bash
systemctl --user status jakes-brain-tunnel
journalctl --user -u jakes-brain-tunnel -f
```
