# Pixel Helper

A Chrome DevTools panel for building and testing [Choreograph Create](https://create.choreograph.com/) pixels with [`choreograph-create-pixel`](https://www.npmjs.com/package/choreograph-create-pixel). Pick data from the client's site, get a ready-to-paste `new Pixel({...})` config, test it on the live page, and optionally let GitHub Copilot (through VS Code) draft the pixel for you.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open DevTools (Cmd+Option+I) on a normal `http(s)` page and select the **Pixel Helper** tab. It may be under the `»` menu.

After changing any file, reload the extension and reopen DevTools. There is no build step.

The toolbar icon only shows a reminder; the panel lives in DevTools.

## Using the panel

The header has a **Source** selector for where values come from. The right side has three tabs: **Pixel**, **URL** and **Copilot**.

### Sources

| Source    | What it does                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dataLayer | Browse `window.dataLayer` (or any global name you type) as a tree, search keys and values, and click a value to turn it into a scrape expression.                                                                                                         |
| DOM       | Search the page by text or attribute value, or use **Select on page** to click an element. Choose a selector from the suggestions, pick what to read (text or an attribute), and preview the value. The matched elements get a green outline on the page. |
| URL       | Split the page URL into parts (host, path segments, query parameters, hash), optionally split a part on a separator or apply a regex, and join several parts.                                                                                             |
| Window    | Search all custom `window` globals by key or value (for sites without a `dataLayer`), or open a global as the data layer to browse it.                                                                                                                    |

Expressions are generated for the selected pixel type: scalar values for scraper fields, and `.map(...)` over arrays for `viewed`, `basketed` and `purchased` SKUs.

### Pixel tab

- **Advertiser ID**, **Type** (`scraper`, `viewed`, `basketed`, `purchased`, `attribution`, `conversion`) and **Label** (post-click types only).
- **SKU expression** or **scrape fields**, filled from the sources above.
- **Trigger** (`basketed`, `purchased`, `conversion`): fire on click instead of on scrape changes. Use **Select on page** to pick the button, then a suggested selector. The event is always `click`.
- **Output**: the generated code, with a copy button.
- **Test pixel**: runs the real library on the current page with debug on, like loading it with `?pixel_debug`, and shows the result in the panel.

> **Test pixel sends real requests.** `viewed`, `basketed`, `purchased` and `conversion` pixels send an event to Choreograph, `attribution` writes the `ccpid` to the page's `localStorage`, and `conversion` clears the stored `ccpid`. Scrapers use the library's validate-only endpoint. With a trigger, the test waits up to 30 seconds for you to click the button.

### URL tab

Builds the `url` regex from the site sections you visit. Each top-level section (`/jewelry`, `/watches`, …) is saved while you browse, and ticking them produces a pattern like `tiffany\.com\/(jewelry|watches)(?:\/|$)`. Product pages are never used as sections. The list is stored per site in the panel's `localStorage`.

### Copilot tab

Lets Copilot build or fix the pixel while you stay in the panel. See [Copilot setup](#copilot-setup).

1. Describe what you need, for example `A viewed pixel for product pages and a basketed pixel on the "Add to basket" button`. Put button labels in quotes so the trigger can be checked against them.
2. Press **Build with Copilot**.

The prompt contains the library rules, the page URL, the data sources in priority order (dataLayer, then URL, then DOM), the visible DOM (buttons with their text first), your current draft and the last test result. Copilot replies with JSON, which fills the panel.

The panel then runs every expression on the live page and checks the URL pattern and trigger selector. If something returns nothing, or a trigger matches the wrong button, the failures are sent back to Copilot for up to two fixes. Anything still failing is listed when the pixel is loaded. **Copy prompt** copies the prompt for use anywhere else.

Press Build again after a test to ask Copilot to fix errors; the last test result is included automatically.

## Copilot setup

The Chrome extension talks to a small VS Code extension in [`vscode-bridge/`](vscode-bridge), which uses VS Code's Language Model API to call your Copilot models. It listens on `127.0.0.1:47821` only.

1. **[Download pixel-helper-bridge.vsix](https://github.com/jessehehl-vml/pixel-helper/raw/HEAD/downloads/pixel-helper-bridge.vsix)**, then in VS Code open the Extensions view, click the `...` menu at the top and choose **Install from VSIX...**. Select the downloaded file. No terminal is needed.
2. Reload VS Code. The status bar shows `Pixel Helper :47821`.
3. Run **Pixel Helper: Authorize Copilot** once and accept the consent dialog.
4. Run **Pixel Helper: Copy Bridge Token** (or click the status bar item).
5. In the panel, open **Copilot → Connection to VS Code**, paste the token and press **Check connection**.

To update, download the new file and install it the same way.

Settings: `pixelHelperBridge.port` (default `47821`; change the port in the panel too) and `pixelHelperBridge.model` (a Copilot model family, empty for the first available).

Every VS Code window starts its own copy of the bridge. Windows that find the port taken show `(other window)` in the status bar and take over if the active window closes.

Requirements: VS Code 1.95 or later, a GitHub Copilot subscription, and VS Code running while you use the panel. The Language Model API has rate limits.

### Rebuilding the download

After changing anything in `vscode-bridge/`, rebuild the file that the download link points to and commit it:

```sh
cd vscode-bridge
npx @vscode/vsce package --allow-missing-repository --skip-license --no-dependencies -o ../downloads/pixel-helper-bridge.vsix
```

You can also install it from the terminal with `code --install-extension downloads/pixel-helper-bridge.vsix`. If `code` is not on your PATH, run **Shell Command: Install 'code' command in PATH** in VS Code.

## Security notes

- The bridge only binds to `127.0.0.1`. It rejects requests without the token, from any origin that is not a `chrome-extension://` page, and with an unexpected `Host` header.
- The prompt includes page data. A hostile site could try to steer the model, so review what Copilot loads before testing it. The panel runs Copilot's expressions on the page to check them, with the page's own privileges only; the extension's token is not reachable from the page.
- Test pixel sends real requests (see above).

## What the panel leaves on the page

Nothing is saved on the site. While you work, the panel may add temporary items to the page: green outline styles (`#__pixelHelperHl_*`), the on-page picker overlay, and globals named `__pixelHelperHits`, `__pixelHelperPick` and `__pixelHelperLive`. They are removed when you finish picking or testing, and a page reload clears everything. The library's trigger listeners can remain until reload, but test instances expire after the test.

## Files

| Path                                       | Purpose                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `manifest.json`                            | Manifest V3. Registers the DevTools page and allows `http://127.0.0.1/*` for the bridge. |
| `devtools.html`, `devtools.js`             | Creates the DevTools panel.                                                              |
| `panel.html`, `panel.css`, `panel.js`      | The panel UI and all of its logic.                                                       |
| `popup.html`                               | Toolbar popup that points to the DevTools panel.                                         |
| `lib/choreograph-create-pixel.iife.min.js` | Vendored copy of the library (v1.5.0), used by Test pixel and the previews.              |
| `vscode-bridge/`                           | VS Code extension (`extension.js`, `server.js`) exposing Copilot to the panel.           |
| `downloads/pixel-helper-bridge.vsix`       | Built VS Code extension that the README download link points to.                         |

To update the vendored library:

```sh
npm pack choreograph-create-pixel
tar -xzf choreograph-create-pixel-*.tgz
cp package/dist/bundle.iife.min.js lib/choreograph-create-pixel.iife.min.js
```

## Limitations

- Elements inside iframes cannot be picked or searched.
- Window search covers custom properties of `window` (not `let` or `const` variables), up to 100 results, 7 levels deep.
- The DOM listing sent to Copilot is capped (about 6,000 characters, 12,000 on a retry). The page must be showing the data when you press Build.
- Without a quoted label in your request, the trigger check can only confirm that the selector matches something.
- Chrome only, loaded unpacked.
