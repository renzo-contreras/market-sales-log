# Setup guide

This guide gets the Market Sales app running at **market.renzocontreras.art**. Do the steps in order. Each one is small. Plan on about 45 minutes, plus some waiting while the domain connects.

You need:

- Your Google account (the one whose Gmail gets the payment receipts)
- Your GitHub account (`renzo-contreras`)
- Your Porkbun login
- This folder (`market-sales-log`) on your computer

If something does not look like what is described here, stop and ask Claude before guessing.

---

## Part A: Google (where your data lives)

### Step 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) while signed in to your Google account.
2. Click "Untitled spreadsheet" at the top left and name it **Market Sales Log**.

This sheet is your database. Every sale and product ends up here.

### Step 2. Add the script to the Sheet

1. In the Sheet's menu, click **Extensions > Apps Script**. A new tab opens with a code editor.
2. Click "Untitled project" at the top and name it **Market Sales Backend**.
3. On the left you see a file called `Code.gs` with a few lines of code. Select all of that code and delete it.
4. On your computer, open `apps-script/Code.gs` from this folder in TextEdit. Copy everything and paste it into the editor.
5. Click the gear icon on the left (**Project Settings**). Tick **Show "appsscript.json" manifest file in editor**.
6. Go back to the editor (the `< >` icon on the left). Click the new `appsscript.json` file. Delete what is there, then paste the contents of `apps-script/appsscript.json` from this folder.
7. Press **Cmd + S** to save.

### Step 3. Run the one-time setup

1. At the top of the editor, find the dropdown next to "Debug". Choose **setup**.
2. Click **Run**.
3. Google asks for permission the first time. Here is what you will see:
   - "Authorization required": click **Review permissions**.
   - Pick your Google account.
   - "Google hasn't verified this app": click **Advanced**, then **Go to Market Sales Backend (unsafe)**. It says "unsafe" only because you wrote the app yourself and did not send it to Google for review. It runs in your account only.
   - Click **Allow**.
4. At the bottom, the log should say "Setup done".
5. Go back to the Sheet tab. You should now see three tabs at the bottom: **Products**, **Sales** and **Receipts**, each with column names in the first row.

### Step 4. Set the password

1. In the Apps Script tab, click the gear icon (**Project Settings**).
2. Scroll down to **Script Properties** and click **Add script property**.
3. Property: `APP_PASSWORD`
4. Value: a long password, at least 16 characters. Four random words is a good choice, for example `cactus-violet-tram-ninety`. (Make up your own. Do not use this one.)
5. Click **Save script properties**.

Share the password with your partner in person or through a private message. It never goes into the GitHub repo.

### Step 5. Deploy the web app

1. In the Apps Script editor, click the blue **Deploy** button (top right), then **New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Fill in:
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**. Click **Authorize access** if it asks again (same steps as before).
5. Copy the **Web app URL**. It is long and ends in `/exec`. Paste it somewhere safe for the next step.

"Anyone" means the app on your phone can reach the script without a Google login. Your data is still protected: the script rejects every request that does not include the correct password.

**Quick test:** paste the URL into your browser. You should see `{"ok":true,"message":"Market Sales Log backend is running."}`.

> **If you ever change the script code later:** go to Deploy > Manage deployments, click the pencil icon, set Version to **New version**, and click Deploy. This keeps the same URL. Making a "New deployment" instead creates a new URL, and the app would stop working until you update `config.js`.

### Step 6. Connect the app to the script

1. Open `config.js` from this folder in TextEdit.
2. Find the line `API_URL: '',` and paste your URL between the quotes, like this:
   `API_URL: 'https://script.google.com/macros/s/AKfy.../exec',`
3. Save the file.

The URL is fine to make public. Only the password protects the data.

### Step 6b. Turn on the captcha (Google reCAPTCHA)

After the password, the sign in screen shows an "I'm not a robot" box. It needs two keys from Google.

1. Go to **google.com/recaptcha/admin/create**, signed in with the same Google account.
2. Fill in:
   - Label: `Market Sales`
   - reCAPTCHA type: **Challenge (v2)**, then **"I'm not a robot" Checkbox**
   - Domains: `market.renzocontreras.art`
3. Click **Submit**. Google shows two keys: a **Site key** and a **Secret key**.
4. **Site key** (public): in `config.js`, paste it between the quotes on the line `RECAPTCHA_SITE_KEY: '',` and save.
5. **Secret key** (private): in Apps Script, open Project Settings > Script Properties (like Step 4), add a property named `RECAPTCHA_SECRET` and paste the secret key as the value. Save. Never put the secret key in `config.js` or anywhere in the repo.

When you first authorize the script, Google lists "Connect to an external service". That permission is what lets the script ask Google whether the captcha passed.

The captcha only appears when signing in. Devices that are already signed in are not asked again.

---

## Part B: GitHub (where the app lives)

You can also ask Claude to do Steps 7 and 8 for you from the terminal.

### Step 7. Create the repo and upload the files

1. Go to [github.com/new](https://github.com/new).
2. Repository name: `market-sales-log`. Choose **Public**. Do not add a README. Click **Create repository**.
3. On the next page, click the link **uploading an existing file**.
4. Open the `market-sales-log` folder in Finder, select everything inside it (Cmd + A), and drag it into the browser window. This includes the `icons` and `apps-script` folders.
5. Check that the list includes `index.html`, `app.js`, `styles.css`, `config.js`, `manifest.webmanifest`, `CNAME`, `README.md`, `SETUP.md`, and files inside `icons/` and `apps-script/`.
6. Click **Commit changes**.

### Step 8. Turn on GitHub Pages

1. In the repo, click **Settings**, then **Pages** in the left menu.
2. Under "Build and deployment", set Source to **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Click **Save**.
3. Under "Custom domain", type `market.renzocontreras.art` and click **Save**.

---

## Part C: Porkbun (the web address)

### Step 9. Point the subdomain at GitHub

1. Log in to Porkbun and open **Domain Management**.
2. Next to `renzocontreras.art`, click **DNS**.
3. Add a record:
   - Type: **CNAME**
   - Host: `market`
   - Answer: `renzo-contreras.github.io`
   - TTL: leave the default
4. Click **Add**.
5. Wait 10 to 60 minutes. Then go back to GitHub > Settings > Pages. When it says the DNS check succeeded, tick **Enforce HTTPS**. (That box can take up to an hour to become clickable.)

Open **https://market.renzocontreras.art** to check. You should see the sign-in screen.

---

## Part D: Phones and products

### Step 10. Install on the phone and iPad

On each device:

1. Open **Safari** and go to `market.renzocontreras.art`.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open Market Sales from the home screen and enter the password once. The device stays signed in.

### Step 11. Add your products

1. Open the **Products** tab.
2. Tap **Import list** and paste your products, one per line: `Name, Category, Price, Stock`. Stock is how many you bring, and it is required. You can also choose a CSV file.
3. Check the preview, then tap **Import**.
4. Open the Sheet: the **Products** tab now has your products. You can also add, edit or hide products in the app later, and change the stock any time.

---

## Part E: Practice run (late November)

Do this on both devices, using a real connection like the one at the market:

- [ ] Ring up about 10 fake sales using every payment method (choose the method, then tap Confirm).
- [ ] Include a discount, a changed price (tap the price in the cart) and a custom item.
- [ ] Tap **Undo** right after one sale. Cancel another one from the **Sales** tab (tap the sale, then **Cancel sale**).
- [ ] Check that the other device shows the new sales within about 30 seconds.
- [ ] Open the Google Sheet and check the rows in the **Sales** tab.
- [ ] Turn on Airplane Mode, make a sale, and check that the top button turns red and says "Not saved". Turn Airplane Mode off and check that it saves by itself (or tap Retry).
- [ ] Open **Totals**, check the 10% fee and the Items sold table, then try **Print or save PDF** and **Download CSV**.
- [ ] Check that stock goes down as you sell and comes back when you cancel a sale.
- [ ] Time a few sales. If anything feels slow or awkward, tell Claude.

**Afterward, clear the practice sales:** in the Sheet's **Sales** tab, select the practice rows (click row numbers, holding Shift), right-click, and choose **Delete rows**. Never delete row 1 (the column names).

---

## Practice mode (no setup needed)

To try the app with fake data before or during setup, open:

`https://market.renzocontreras.art/?mock`

The password in practice mode is `practice-password`. Practice mode also shows the captcha, using a Google test key that always passes (it shows a small red "testing only" note). Practice mode has the same lockout; add `&unlock` to the address to clear it. Practice data stays in that browser only and never touches the Sheet. The header says "Practice mode" so you can tell it apart. Close the tab to leave practice mode.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "The app is not connected yet" | `config.js` does not have the web app URL yet. See Step 6. |
| "Wrong password" | Check the password in Script Properties (Step 4). It is case sensitive. |
| "Could not reach the server" | Check your connection. If the connection is fine, open the web app URL in a browser (Step 5 quick test). |
| "The password has not been set up yet" | Add `APP_PASSWORD` in Script Properties (Step 4). |
| Changes to the script do nothing | Publish a new version: Deploy > Manage deployments > pencil > New version (see the note in Step 5). |
| Sign-in page after changing the password | Expected. Every device needs the new password once. |
| Site not found at market.renzocontreras.art | DNS may still be updating. Wait an hour and check Step 9. |
| "Please complete the captcha" or "The captcha check did not pass" | Tap Enter again and tick the box. If it keeps failing, check that the site key in `config.js` and `RECAPTCHA_SECRET` in Script Properties come from the same reCAPTCHA site (Step 6b). |
| The captcha box does not show, or says "Invalid domain" | In the reCAPTCHA admin page, check that `market.renzocontreras.art` is in the domain list (Step 6b). |
| "Too many wrong passwords. Locked for safety." | Someone (maybe you) typed a wrong password 10 times in 10 minutes. The app is locked for 15 minutes. Sales you make in the meantime stay on the device and save on their own when the lock ends. To end it right away, see "Emergency unlock" below. |

---

## Emergency unlock

After 10 wrong passwords within 10 minutes, the app refuses everyone for 15 minutes, even with the right password. This stops anyone from guessing the password. If it ever happens to you at the market:

1. On any device, open your Google Sheet and click **Extensions > Apps Script**.
2. In the dropdown next to "Debug", choose **unlock**.
3. Click **Run**. The log says "Unlocked".
4. Back in the app, tap the red **Retry** button. Any held sales save.

If you see the lockout and nobody on your side mistyped, someone else is trying to guess. Change the password (Step 4), run **unlock**, then enter the new password once on each device.

---

## Coming in phase 2: automatic Gmail receipts

This part comes after phase 1 works. Before it can be built:

1. Send a **$1 test payment** to yourself on Venmo, PayPal, Cash App and Zelle.
2. Forward or share one receipt email from each with Claude (or paste the text), so the parsers can be written for the exact format.
3. Then Claude will help you create Gmail filters that apply the label `market-receipts`, using the sender addresses from those emails.
