<div align="center">

# ⛏️ Ekalavya

**Professional ASIC Mining Management Platform**

*Monitor · Control · Manage · Bill — from anywhere in the world*

[![Deploy Frontend](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/deploy-frontend.yml/badge.svg)](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/deploy-frontend.yml)
[![Deploy Backend](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/deploy-backend.yml/badge.svg)](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/deploy-backend.yml)
[![CI Checks](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-USERNAME/ekalavya/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)
![License](https://img.shields.io/badge/License-Private-red)

[Live App](https://YOUR-USERNAME.github.io/ekalavya) · [API Health](https://your-backend.up.railway.app/health) · [Setup Guide](#setup)

</div>

---

## What is Ekalavya?

Ekalavya is a full-stack ASIC mining management platform built for professional mining operations running machines across multiple farms and locations. It lets you monitor, control, and bill for miners remotely — from a phone or browser, anywhere in the world.

Think of it as **Foreman + billing software + customer portal**, all in one.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Remote Monitoring** | Live hashrate, temperature, fan speed, power draw for every miner |
| **Farm Agents** | Lightweight agent runs on a farm PC, dials out — no port forwarding needed |
| **Network Scanner** | Scan any IP range via an agent to auto-discover ASIC miners |
| **Miner Control** | Restart, reboot, sleep, LED blink, change pool, change worker ID, firmware upgrade, factory reset, disable for repair, delete |
| **Multi-Farm** | Manage farms in Dubai, Kazakhstan, USA, China — all from one dashboard |
| **Customer Portal** | Each customer logs in and sees only their assigned miners |
| **Billing** | Monthly hosting fees, estimated earnings, net profit per customer |
| **World Pools** | 18 major mining pools with live stats and one-click switching |
| **Profitability** | Live calculator for 15+ ASIC models with real BTC/KAS/LTC prices |
| **ASIC Chip Monitor** | Chip-level health — dead chips, hot chips, board-by-board breakdown |
| **Team Access** | Role-based access: Admin, Manager, Technician, Viewer |
| **Alerts** | Real-time alerts for offline miners, high temps, hashrate drops |
| **PWA** | Installs on iPhone and Android as a native-looking app |

---

## Architecture

```
GitHub Repository
├── frontend/    →  GitHub Pages        (auto-deploys on push, free)
├── backend/     →  Railway.app         (auto-deploys on push, ~$5/mo)
└── agent/       →  Farm Windows PCs    (download once, runs forever)
```

```
Your Phone / Browser
        │
        ▼
GitHub Pages  ──  ekalavya frontend (PWA)
        │
        ▼  (API + WebSocket)
Railway.app  ──  Ekalavya backend (Node.js + Express + WS)
        │
        ▼  (persistent outbound WebSocket tunnels)
Farm PC Dubai  ──  ekl-agent  ──►  scans & polls 192.168.x.x miners
Farm PC KZ     ──  ekl-agent  ──►  scans & polls 10.1.0.x miners
Farm PC USA    ──  ekl-agent  ──►  scans & polls 172.16.x.x miners
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS · PWA · Service Worker |
| Backend | Node.js · Express · WebSocket (ws) · JWT auth |
| Deployment | GitHub Actions · GitHub Pages · Railway.app |
| ASIC APIs | CGMiner TCP (port 4028) · Antminer HTTP · Whatsminer TCP |
| Crypto Prices | CoinGecko API (BTC, ETH, LTC, DOGE, KAS) |
| Alerts | Telegram Bot · Slack / Discord webhook |

---

## Supported Hardware

**Antminer:** S21, S19 XP, S19 Pro, S19j Pro, T19, KA3 (Kaspa), L7 (Litecoin), D9

**Whatsminer:** M50, M53, M30S++, M30S+, M60

**AvalonMiner:** 1466, 1246

**Goldshell:** KD-Box Pro, HS-Box

**Others:** Any CGMiner-compatible miner (port 4028)

---

## Setup

### Prerequisites

- GitHub account (free)
- Railway.app account (free tier — $5/month credit included)
- Node.js 20+ on farm PCs (nodejs.org)

### 1 — Upload to GitHub

1. Create a new private repo named `ekalavya` on GitHub
2. Upload all files from this project (drag & drop via GitHub web UI or GitHub Desktop)

### 2 — Deploy Backend on Railway

1. Go to railway.app → **New Project** → **Deploy from GitHub repo** → select `ekalavya`
2. Set root directory to **`backend`**
3. Add these environment variables in Railway dashboard:

```env
JWT_SECRET=your_long_random_secret_here
AGENT_KEYS=your_farm_agent_key_here
NODE_ENV=production
FRONTEND_URL=https://YOUR-USERNAME.github.io/ekalavya
```

Copy your Railway URL (e.g. `https://ekalavya-backend-production.up.railway.app`)

### 3 — Enable GitHub Pages (Frontend)

1. Repo → **Settings** → **Pages** → Source: **GitHub Actions** → Save
2. Repo → **Settings** → **Secrets** → **Actions** → Add secret:
   - Name: `RAILWAY_BACKEND_URL`
   - Value: your Railway URL from Step 2
3. Go to **Actions** tab → **Deploy Frontend → GitHub Pages** → **Run workflow**

App is live at `https://YOUR-USERNAME.github.io/ekalavya`

### 4 — Farm Agent (Windows)

On each farm PC:

1. Download the `agent/` folder from this repo
2. Double-click **`SETUP-WINDOWS.bat`**
3. Fill in the `.env` file when Notepad opens:

```env
MMX_SERVER=wss://ekalavya-backend-production.up.railway.app/agent
AGENT_KEY=your_farm_agent_key_here
FARM_NAME=Farm Dubai
LOCAL_SUBNET=192.168.1.0/24
```

4. Save → press any key → the farm appears in the dashboard

The agent auto-starts on Windows boot and auto-reconnects if internet drops.

---

## Default Credentials

> ⚠️ Change these in `backend/src/routes/auth.js` before going live

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Technician | `tech` | `tech123` |
| Viewer | `viewer` | `view123` |

Customer accounts are created through the app's Customers page.

---

## GitHub Actions Workflows

| Workflow | Triggers on | Action |
|----------|-------------|--------|
| `deploy-frontend.yml` | Push to `frontend/**` | Injects Railway URL → deploys to GitHub Pages |
| `deploy-backend.yml` | Push to `backend/**` | Logs deploy (Railway auto-deploys via GitHub integration) |
| `ci.yml` | Every push & PR | Syntax checks on backend and agent |

**Every push to `main` → automatic deployment. No manual steps.**

---

## Making Changes

Edit files on GitHub.com directly or via GitHub Desktop, commit to `main` — GitHub Actions handles the rest.

```
Edit code  →  Commit to main  →  Actions run  →  Live in ~3 minutes
```

---

## Project Structure

```
ekalavya/
├── .github/
│   └── workflows/
│       ├── deploy-frontend.yml   ← Auto-deploy frontend to GitHub Pages
│       ├── deploy-backend.yml    ← Trigger Railway backend deploy
│       └── ci.yml                ← Syntax checks on every push
│
├── frontend/
│   ├── index.html                ← Complete PWA (single file app)
│   ├── manifest.json             ← PWA install manifest
│   ├── sw.js                     ← Service worker for offline support
│   ├── icon-192.png              ← App icon
│   └── icon-512.png              ← App icon (large)
│
├── backend/
│   ├── src/
│   │   ├── server.js             ← Express server entry point
│   │   ├── websocket.js          ← Real-time push to frontend
│   │   ├── middleware/
│   │   │   └── auth.js           ← JWT authentication
│   │   ├── routes/
│   │   │   ├── auth.js           ← Login / token
│   │   │   ├── workers.js        ← Worker CRUD + live stats
│   │   │   ├── actions.js        ← Reboot, sleep, pool, firmware...
│   │   │   ├── scanner.js        ← Network scanner (SSE stream)
│   │   │   ├── customers.js      ← Customer portal + assignment
│   │   │   ├── agents.js         ← Farm agent management
│   │   │   ├── prices.js         ← Live crypto prices
│   │   │   └── stats.js          ← Fleet summary + alerts
│   │   └── services/
│   │       ├── cgminer.js        ← CGMiner TCP API (port 4028)
│   │       ├── antminer.js       ← Antminer HTTP API (port 80)
│   │       ├── whatsminer.js     ← Whatsminer TCP API
│   │       ├── scanner.js        ← IP range scanner
│   │       ├── agentManager.js   ← Farm agent WebSocket manager
│   │       ├── poller.js         ← Auto-polls miners every 30s
│   │       ├── customerAccess.js ← Customer-miner assignment
│   │       ├── alerts.js         ← Telegram/Slack/Discord alerts
│   │       ├── profitability.js  ← Revenue calculator
│   │       └── store.js          ← In-memory data store
│   ├── package.json
│   ├── railway.json              ← Railway deployment config
│   └── .env.example              ← Environment variable template
│
├── agent/
│   ├── agent.js                  ← Farm agent (runs on farm Windows PC)
│   ├── package.json
│   ├── .env.example              ← Agent configuration template
│   ├── SETUP-WINDOWS.bat         ← One-click Windows setup script
│   └── START.bat                 ← Quick start without PM2
│
├── docs/
│   └── GITHUB-DESKTOP-SETUP.md  ← Setup guide without command line
│
├── .gitignore
├── package.json                  ← Monorepo root
└── README.md                     ← This file
```

---

## API Reference (Quick)

```
POST /api/auth/login              Login (admin/team/customer)
GET  /api/workers                 List all workers
POST /api/workers                 Add worker
GET  /api/workers/:id/refresh     Force re-poll
POST /api/scanner/start           Start network scan
GET  /api/scanner/:id/stream      SSE stream of scan progress
POST /api/actions/restart         Restart mining software
POST /api/actions/reboot          Hard reboot
POST /api/actions/sleep           Sleep mode
POST /api/actions/set-pool        Change pool
POST /api/actions/set-worker-id   Rename worker
POST /api/actions/disable         Disable for repair
POST /api/actions/firmware-upgrade Flash firmware
POST /api/actions/factory-reset   Factory reset
DELETE /api/actions/:id           Delete from fleet
GET  /api/actions/logs/:id        Fetch miner logs
GET  /api/customers/portal/workers Customer's miners only
GET  /api/prices                  Live BTC/ETH/LTC/KAS/DOGE
GET  /api/stats/fleet             Fleet summary
GET  /health                      Server health check
```

WebSocket: `wss://your-backend.up.railway.app/ws` — live miner updates
Agent WS:  `wss://your-backend.up.railway.app/agent` — farm agent tunnel

---

<div align="center">

**Ekalavya v1.0.0** · Built for professional ASIC mining operations

*Push to deploy · No servers to manage · Works from anywhere*

</div>
