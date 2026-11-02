# Claude connector

Claude can read and change Jake's Brain the same way it works with Notion: as a **custom
connector** (a remote MCP server). The server is in `server/apps/connector.js`. These files put
it on the internet.

```
Claude (app / claude.ai / Claude Code)
   │  https://<public address>/mcp/<secret>
   ▼
tunnel (ngrok or Cloudflare) ── runs on the PC as jakes-brain-tunnel.service
   │
   ▼
127.0.0.1:4801  connector: answers only POST /mcp/<secret>, 404 for everything else
   │  loopback
   ▼
127.0.0.1:4800  the normal app API (stays LAN + tailnet only)
```

The connector URL is the password: 64 random hex characters, stored in
`~/jakes-data-app-data/connector/secret` on the PC. Anyone who has the URL can read and change
the data that the tools reach (food, tasks, groceries, notes). If the URL leaks, use
**Settings → Claude connector → Make a new URL**. The old URL stops working immediately.

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

The script prints the connector URL. The same URL appears in **Jake's Brain → Settings → Claude
connector**, with a Copy button.

## Add it to Claude

- **Claude app / claude.ai:** Settings → Connectors → Add custom connector. Name it
  `Jake's Brain` and paste the URL (leave the OAuth fields empty). It then works in every chat,
  on the phone too.
- **Claude Code:** `claude mcp add --transport http jakes-brain <URL>`

Then just talk to it: "log 4 eggs and PB toast for breakfast", "what have I eaten today",
"set my goal to 2400 calories and 180 g protein", "move my Notion food log into Jake's Brain".

## Moving the Notion history over

Ask Claude, with both the Notion and Jake's Brain connectors on: *"Copy every row of my Notion
Macros & Calories Tracker into Jake's Brain with food_log. Use each page's URL as ext_id."* The
`ext_id` makes this safe to repeat, because rows that were already copied are skipped.

## Checking on it (on the PC)

```bash
systemctl --user status jakes-brain-tunnel
journalctl --user -u jakes-brain-tunnel -f
```
