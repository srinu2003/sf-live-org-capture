---
name: sf-live-org-capture
description: >-
  Strictly read-only fast headless Chrome CDP live-org screenshot capture for Salesforce Lightning pages, tabs, and
  Lightning Web Components. Use this skill ONLY to visually inspect, capture, and verify live Salesforce org UI as-is.
  STRICT POLICY: This skill strictly NEVER edits codebase files, changes org configurations/permissions, or deploys metadata.
---

# Salesforce Live Org Screenshot Capture (`sf-live-org-capture`)

Captures production-accurate 1600Ã—1000 screenshots directly from an authenticated Salesforce org in ~4â€“7 seconds using Headless Chrome DevTools Protocol (CDP) and `sf org open --url-only`.

---

## â›” STRICT READ-ONLY POLICY & BOUNDARIES

**This skill is strictly limited to observation, inspection, and screenshot capture.**

When using or invoked via `/sf-live-org-capture`:
1. **NEVER Edit Code**: Do NOT modify, write, patch, or alter any codebase files (LWC, Apex, Visualforce, CSS, HTML, JavaScript, metadata XML).
2. **NEVER Change Org Configuration**: Do NOT modify org settings, preferences, permissions, or records (e.g., strictly NO `sf org assign permset`, NO data manipulation, NO setting toggles).
3. **NEVER Deploy to Org**: Do NOT execute metadata or source deployments (strictly NO `sf project deploy start`, NO package installations).
4. **Read & Capture Only**: Only inspect existing metadata/logs for diagnosis and run `capture_sf.js` to observe the live UI as it exists.
5. **Report Only**: If an issue, configuration gap, or code bug is discovered, clearly document and explain the findings to the user. Do NOT attempt to fix or deploy changes automatically.

---

## How It Works

1. **Authenticated Frontdoor URL**: Runs `sf org open --path "<url-path>" --url-only --json` to get a session-authenticated frontdoor URL without manual login prompts. Accepts either a full Lightning URL (`https://.../lightning/...`) or a relative path (`/lightning/...`).
2. **Per-Workspace Target Memory**: Automatically saves the last-used `--url` and `--wait-for` selector per workspace directory (`C:\Users\tsiri\AppData\Local\Temp\chrome_sf_cache\workspace_targets.json`). Subsequent captures in the same project reuse the remembered URL and component automatically without needing `--url` again.
3. **Warm Browser Profile + Fresh Network Assets**: Launches headless Chrome on port `9333` reusing a persistent local profile (`C:\Users\tsiri\AppData\Local\Temp\chrome_sf_cache`) so Salesforce framework shells load quickly, while setting `Network.setCacheDisabled({ cacheDisabled: true })` so newly viewed LWC changes are never stale.
4. **Recursive Shadow DOM Readiness Polling**: Pierces nested LWC Shadow DOMs (`queryShadow`) to verify the target component is mounted and any `lightning-spinner` has finished before snapping.
5. **Cache-Proof Timestamped Output**: Writes every screenshot to `<out-dir>/live_org_capture_<timestamp>.png` so chat markdown previews never display a cached earlier image.

---

## Resolving the Target URL / Path

Determine the target Lightning URL or path in this order (do **not** ask the user if steps 1â€“3 resolve it):
1. **User-Provided URL or Path**: If the user shared a full URL (`https://...lightning.force.com/lightning/...`) or relative path (`/lightning/...`), pass it via `--url` (this also updates the workspace cache).
2. **Cached Workspace Target**: If `--url` is omitted, `capture_sf.js` automatically reuses the last URL and `--wait-for` selector saved for the current workspace directory in `workspace_targets.json`.
3. **Workspace Metadata Discovery (Read-Only)**: On first use in a workspace, inspect `force-app/main/default/flexipages/*.flexipage-meta.xml` and `force-app/main/default/tabs/*.tab-meta.xml` in read-only mode to see which tab or page hosts the LWC being inspected (e.g., `/lightning/n/<Tab_DeveloperName>`).
4. **Ask Only Once**: Only ask the user for the URL if there is no cached target for the workspace and the hosting page cannot be inferred from local metadata.

---

## Usage

Run [`scripts/capture_sf.js`](./scripts/capture_sf.js) via `node`:

```powershell
# First run in a workspace (or when changing target URL):
node "C:\Users\tsiri\.gemini\config\skills\sf-live-org-capture\scripts\capture_sf.js" `
  --url "<full-lightning-url-or-relative-path>" `
  --wait-for "<c-component-tag>" `
  --out-dir "<artifactDirectoryPath>"

# Subsequent runs in the same workspace (automatically reuses cached --url and --wait-for):
node "C:\Users\tsiri\.gemini\config\skills\sf-live-org-capture\scripts\capture_sf.js" `
  --out-dir "<artifactDirectoryPath>"
```

### CLI Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--url <url>` / `--path <path>` | Full Lightning URL (`https://.../lightning/...`) or relative path (`/lightning/...`). Automatically remembered per workspace. | Cached workspace URL (or `/lightning/page/home`) |
| `--org <alias>` | Target Salesforce org alias or username. | Project's default `target-org` |
| `--wait-for <selector>` | Custom element tag (e.g., `c-my-lwc`) or selector inside Shadow DOM to wait for until its `lightning-spinner` disappears. Automatically remembered per workspace. | Cached workspace selector (or global shell) |
| `--click <selector>` | Optional selector to click before snapping (useful for capturing toggled states, modals, or drawers). | `null` |
| `--settle-ms <ms>` | Extra settle time (in ms) after spinner removal before taking the screenshot. | `2000` |
| `--out-dir <dir>` | Directory where `live_org_capture_<timestamp>.png` will be saved. | Current working directory |
