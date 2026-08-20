# GovGuard – Microsoft Copilot Studio Deployment Guide

## What is this?

This folder contains the complete Microsoft 365 Copilot Studio deployment package for GovGuard. The agent is a **declarative Copilot** that surfaces the GovPal-GovGuard backend as an intelligent governance assistant inside Microsoft Teams / M365 Copilot.

## Package Contents

| File | Purpose |
|------|---------|
| `teams-manifest.json` | Teams App Manifest v1.19 — registers the app in Microsoft 365 |
| `declarative-agent.json` | Declarative Copilot configuration (capabilities + actions) |
| `plugin.json` | API Plugin manifest mapping functions to OpenAPI operations |
| `openapi.yaml` | Full OpenAPI 3.0.3 spec for the backend API |
| `instructions.md` | System prompt / persona for the Copilot agent |
| `adaptive-cards/` | Adaptive Card templates for rich responses in Teams |

---

## Prerequisites

- Microsoft 365 E3/E5 licence with **Copilot for Microsoft 365** enabled
- Admin access to **Teams Admin Center** (`admin.teams.microsoft.com`)
- Access to **Microsoft Copilot Studio** (`copilotstudio.microsoft.com`)
- Backend accessible via **HTTPS** (use ngrok for local demo — see below)

---

## Step 1 – Expose the backend with HTTPS

For local development, use [ngrok](https://ngrok.com):

```powershell
# In a separate terminal (ngrok must be installed)
ngrok http 8000
# Note the HTTPS URL, e.g. https://abc123.ngrok-free.app
```

Update `openapi.yaml` → `servers[0].url` with your ngrok URL.

---

## Step 2 – Build the Teams App Package

The package is a ZIP containing:

```
govguard-teams-app.zip
├── teams-manifest.json   (rename to manifest.json)
├── declarative-agent.json
├── plugin.json
├── openapi.yaml
├── instructions.md
├── color.png             (192×192 colour icon — add your own)
└── outline.png           (32×32 outline icon — add your own)
```

```powershell
# Create the package
$files = @("teams-manifest.json","declarative-agent.json","plugin.json","openapi.yaml","instructions.md")
Compress-Archive -Path $files -DestinationPath govguard-teams-app.zip -Force
Rename-Item govguard-teams-app.zip -NewName govguard-teams-app.zip
```

**Important**: Rename `teams-manifest.json` to `manifest.json` inside the ZIP.

---

## Step 3 – Upload to Teams Admin Center

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com) → **Teams apps** → **Manage apps**
2. Click **Upload new app** → **Upload**
3. Select `govguard-teams-app.zip`
4. Once uploaded, set availability to **Specific users or groups** → select CDO team members
5. Click **Allow** on the app

---

## Step 4 – Register in Copilot Studio

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. **Agents** → **New agent** → **Import from Teams app**
3. Select the GovGuard app
4. Review the declarative agent settings (name, instructions, capabilities)
5. Under **Actions** → verify the API plugin loaded the OpenAPI spec correctly
6. Test the agent in the Studio test pane

---

## Step 5 – Publish to CDO Team

1. In Copilot Studio → **Publish** → **Publish to Microsoft Teams**
2. Select the **CDO-Governance** Teams channel
3. The agent appears as **@GovGuard** in Teams messages

---

## Authentication Configuration

The current setup uses **no-auth** (Bearer JWT in the `Authorization` header is required by the API but not configured in the plugin — suitable for demo). For production:

1. Register an Azure AD App Registration for GovGuard
2. In `plugin.json` → change `auth.type` to `"OAuthPluginVault"`
3. Configure the OAuth flow with your Azure AD tenant ID and client ID
4. Update `openapi.yaml` → `securitySchemes` with your Azure AD OAuth2 config

---

## Local Demo (without M365)

The full backend is accessible at `http://127.0.0.1:8000`. Use:

- **Swagger UI**: `http://127.0.0.1:8000/docs` — interactive API explorer
- **ReDoc**: `http://127.0.0.1:8000/redoc` — documentation view
- Test the OpenAPI spec via [Swagger Editor](https://editor.swagger.io/) — paste `openapi.yaml`

Demo credentials:
| Email | Password | Role |
|-------|----------|------|
| `analyst@example.com` | `Analyst123!` | Analyst |
| `manager@example.com` | `Manager123!` | Manager |
| `partner@example.com` | `Partner123!` | Partner |
