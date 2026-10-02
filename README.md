# 9Router All-Time & 60D Usage Extender (Chromium Extension)

A Chromium extension that adds **60D** and **All Time** period selection options to the **9Router** usage dashboard (`http://localhost:20128/dashboard/usage`).

## Features

- 🚀 **Adds "All Time" & "60D" options** to the 9Router Usage tab period selector.
- ⚡ **Seamless Backend API Integration**:
  - `stats`: Leverages 9Router's native `/api/usage/stats?period=all` to compute total lifetime metrics across models, accounts, API keys, endpoints, costs, and token counts.
  - `chart`: Automatically maps chart requests to `/api/usage/chart?period=60d` to display the maximum available timeline without 400 errors.
- 🎨 **Native UI Styling**: Custom buttons adopt 9Router's Tailwind design system (`bg-primary text-white shadow-sm`, etc.).
- 🔄 **Real-time React State Integration**: Interacts cleanly with 9Router's React state fiber tree.

## Installation Instructions

1. Open any Chromium browser (Google Chrome, Brave, Microsoft Edge, Arc, Vivaldi).
2. Navigate to `chrome://extensions/` (or `edge://extensions/` for Edge).
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked**.
5. Select this folder (or download and extract the release zip).

## How to Use

1. Open the 9Router Usage page:
   `http://localhost:20128/dashboard/usage`
2. Under the **Overview** tab, look at the period selector next to `Overview / Details`.
3. Click **60D** or **All Time** to view total usage metrics!

## Files

- `manifest.json`: Manifest V3 Extension Configuration.
- `injected.js`: Main World script handling fetch interception and React Fiber state updates.
- `content.js`: Content script that injects `injected.js` at `document_start`.
- `popup.html` & `popup.js`: Extension toolbar popup menu.
- `icons/`: Extension icons (16px, 48px, 128px).
