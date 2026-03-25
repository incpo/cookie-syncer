# Cookie Sync

Sync browser cookies between devices through an encrypted shared room. One device acts as the **exit node** (source of cookies), others join as **receivers**.

<!-- ![Demo](assets/demo.gif) -->

## How It Works

1. The **exit node** picks which domains to share and pushes encrypted cookies to a room on the server
2. **Receivers** pull from that room and apply the cookies locally
3. All cookie data is encrypted end-to-end — the server only stores an opaque blob

## Quick Start

### 1. Start the Server

```bash
cp .env.example .env
# edit .env and set a strong SERVER_SECRET

docker compose up -d
```

The server runs on `http://localhost:3456`.

<details>
<summary>Run without Docker</summary>

```bash
cd server
bun install
SERVER_SECRET=your-secret bun run index.ts
```
</details>

### 2. Install the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

<!-- ![Install extension](assets/install-extension.png) -->

### 3. Create a Room (Exit Node)

1. Click the extension icon → **Connect** tab
2. Enter your server URL and server secret
3. Click **Create Room**

<!-- ![Create room](assets/create-room.png) -->

### 4. Share Cookies

1. Navigate to a site you want to share
2. Go to the **This Site** tab
3. Click **Share This Site's Cookies**

<!-- ![Share site](assets/share-site.png) -->

### 5. Join from Another Device

1. On the exit node, click **Copy Share String**
2. On the other device, install the extension and go to **Connect** tab
3. Paste the share string, enter the server secret, and click **Join Room**

<!-- ![Join room](assets/join-room.png) -->

### 6. Sync

Receivers can click **Sync Now** or enable **Auto-sync** to pull cookies every 2 minutes.

<!-- ![Sync](assets/sync.png) -->

## Project Structure

```
├── extension/          # Chrome extension (Manifest V3)
│   ├── background/     # Service worker — crypto, sync logic
│   ├── popup/          # Extension popup UI
│   └── manifest.json
├── server/             # Bun + Elysia API server
│   ├── index.ts
│   └── Dockerfile
└── docker-compose.yml
```

## Roadmap

- [ ] **Separate parent domain cookie sharing** — When sharing cookies for `sub.example.com`, cookies scoped to `example.com` are included automatically. Add an option to control whether parent domain cookies are shared alongside subdomain-specific ones.
- [ ] **Add screenshots and video tutorials** — Record GIFs/videos for each setup step and replace the placeholders in the README.
- [ ] **Separate Chrome and Firefox installation guides** — Split browser-specific steps into dedicated sections with tailored instructions for each browser.

## Security

- Cookies are encrypted with AES-256-GCM before leaving the browser
- The encryption key is derived from a shared secret via PBKDF2
- The server never sees plaintext cookie data
- `SERVER_SECRET` protects the API from unauthorized access
- Secrets are stored in session storage and cleared when the browser closes
