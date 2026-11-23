# Market Sales Log

A small internal web app for logging sales at Mistletoe Market from a phone or iPad, with totals, the market's 10% fee, and a report to hand to the market.

Live at **https://market.renzocontreras.art** (private: password required).

**Setting it up?** Follow [SETUP.md](SETUP.md).

## What it does (phase 1)

- **Sign in once** per device with a shared password. The sign-in screen shows only a password field, with no name or hint about the app.
- **Sell:** tap products to build a cart, adjust quantities, change a price or add a discount, then choose the payment method (Zelle, Venmo, PayPal, Cash App, Cash) and tap the green **Confirm** button to record the sale. The time (Mountain Time) and device type are added automatically.
- **Sales:** every sale with time, items, total, method and receipt status. Undo right after a sale, or cancel any sale later. Cancelled sales stay visible, crossed out, and are not counted.
- **Totals:** per day and per payment method, with the market fee and your net.
- **Report:** a printable page (save as PDF) and a CSV with every sale, totals by method, the fee, and receipt links.
- **Products:** add, edit, hide, delete, or import. Each product can have its own discount (% off or $ off) that shows on the Sell screen; from a pasted list or CSV. A required **Stock** (how many you bring) shows items sold and items left on the Sell screen, the Products tab and Totals. Cancelled sales put items back.
- **Appearance:** Menu > Appearance switches between Dark (the default), Light, or Match device. Each device remembers its own choice.
- **Never a silent failure:** each sale saves in the background. The button at the top shows Saved, Saving, or a red "Not saved" with Retry. Unsaved sales stay on the device and retry on their own.

## How it works

```
Phone / iPad (this repo, GitHub Pages)
        |  POST, text/plain JSON, password in every request
        v
Google Apps Script web app (apps-script/Code.gs)
        |
        v
Google Sheet: Products, Sales, Receipts tabs
```

- **Front end:** plain HTML, CSS and JavaScript. No build step, no frameworks. `index.html`, `styles.css`, `app.js`, `config.js`.
- **Back end:** `apps-script/Code.gs`, bound to the Google Sheet and deployed as a web app.
- Requests use `Content-Type: text/plain` so browsers skip the CORS preflight, which Apps Script cannot answer.
- Sale IDs are made on the device, so a retried save never creates a duplicate.
- Two devices can sell at once. Writes use a lock, and each device pulls new sales every 30 seconds.

## Security

- This repo is public. It contains **no sales data and no password**.
- The password lives only in Apps Script **Script Properties** (`APP_PASSWORD`) and is checked on the server for every request. A wrong guess waits 1.5 seconds before answering. After 10 wrong passwords within 10 minutes, every request is refused for 15 minutes (devices stay signed in, and sales are held and saved afterward). Run `unlock` in the script editor to end a lockout early.
- Signing in also needs a Google reCAPTCHA "I'm not a robot" check, verified by the script with Google (secret key in Script Properties as `RECAPTCHA_SECRET`, public site key in `config.js`). It is only asked at sign in, not on every request.
- The password must be at least 12 characters (16 or more recommended).
- Each device keeps the password in its own browser storage so you stay signed in. Use **Menu > Sign out of this device** on a shared or lost device. Changing the password signs out every device.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App page |
| `styles.css` | Layout for phone, iPad and print |
| `app.js` | All app logic, plus a practice mode with fake data |
| `config.js` | Public settings: web app URL, names, fee rate |
| `manifest.webmanifest`, `icons/` | Home screen install |
| `CNAME` | Custom domain for GitHub Pages |
| `apps-script/Code.gs` | Backend: paste into Apps Script |
| `apps-script/appsscript.json` | Backend settings (time zone, web app access) |
| `SETUP.md` | Step-by-step setup and practice-run checklist |

## Practice mode

Add `?mock` to the address to try the app with fake data that stays in the browser. The password is `practice-password`. Add `?mock&fail` to simulate a broken connection.

## Phase 2 (not built yet)

Automatic receipts from Gmail: read emails labeled `market-receipts`, save each as a PDF in a Drive folder "Market Receipts", match it to a sale by amount, method and time, and list unmatched receipts for matching by hand. A screenshot upload covers sales with no email. This waits on one sample receipt email from each payment app.
