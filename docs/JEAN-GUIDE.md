# ShipSafe: your plan to finish and submit

**Deadline: Thursday, Nov 12, 2026, 12:00 PM Pacific = 2:00 PM Austin time.** Aim to submit by **Nov 10** so nothing goes wrong at the last minute.

The app is built and tested. These steps need *you* because they use your own accounts. Do them in order. Send me a message after each one if you get stuck.

---

## Step 1. Register for the hackathon (5 min)
1. Go to **paypalaihackathon.devpost.com**.
2. Click **Join hackathon** and sign in or create a Devpost account.
3. Read the official rules and accept them.

## Step 2. Get PayPal sandbox keys (10 min)
1. Go to **developer.paypal.com** and log in with your PayPal account.
2. Make sure the toggle at the top says **Sandbox**, not Live.
3. Open **Apps & Credentials** and click **Create App**. Name it `ShipSafe`, type **Merchant**.
4. Copy the **Client ID** and **Secret**. Keep the Secret private. Never post it or put it in GitHub.
5. Open **Testing Tools → Sandbox Accounts**. There is a **Personal** (buyer) account. Click it to see its email and password. That fake buyer is what you and the judges use to "pay."

## Step 3. Get an AI key (10 min, about $5)
1. Go to **console.anthropic.com** and create an account.
2. Add a small amount of credit ($5 is plenty for testing and judging).
3. Create an **API key** and copy it. Keep it private.

Tip: set a monthly spend limit in the console so the key can never cost you more than you expect.

## Step 4. Put the code on GitHub (15 min)
1. Create a **public** repository called `shipsafe` on github.com.
2. Upload every file from the ShipSafe folder **except** `node_modules` and any `.env` file.
3. In the repo's **About** section (gear icon), make sure the license shows **MIT**. The rules require a visible open-source license.

## Step 5. Put it online with Render (15 min)
1. Go to **render.com** and sign in with GitHub.
2. Click **New → Blueprint** and pick your `shipsafe` repo.
3. When it asks for environment variables, paste:
   - `PAYPAL_CLIENT_ID` = your sandbox Client ID
   - `PAYPAL_CLIENT_SECRET` = your sandbox Secret
   - `ANTHROPIC_API_KEY` = your AI key
4. Deploy. You'll get a link like `https://shipsafe-xxxx.onrender.com`.
5. Open it. The top chips should say **PayPal sandbox: connected** and **AI review: on**.

Note: Render's free plan "sleeps" after 15 minutes without visitors, so the first visit can take about a minute to wake up. That's normal.

## Step 6. Test it yourself (10 min)
1. On your Render link, add 3 Wool Throw Blankets, pick **Overnight**, and type a note like: *"My shipper will pick up. I'll overpay, please send the difference."*
2. Click the PayPal button and log in with the **sandbox buyer** email/password from Step 2.
3. Open `/dashboard`. The order should show up **on hold** with the AI's reasons.
4. Click **Refund via PayPal**. It should change to Refunded.
5. Paste a scam message into **"Is this message a scam?"** and check the answer.

Then fill in the "Try it (judges)" part of `README.md` with your Render link and the sandbox buyer login (sandbox only, no real money).

## Step 7. Record the demo video (under 3 minutes)
Use the script in `DEMO-SCRIPT.md`. Record your screen with OBS, Loom or the Windows Snipping Tool, with your voice. Upload to **YouTube as Public** (or Unlisted if the rules allow it). Don't use music.

## Step 8. Submit on Devpost
Use the text in `DEVPOST-TEXT.md`. You'll need:
- Project name, short tagline, description (in that file)
- Live demo link (Render)
- GitHub repo link
- YouTube video link
- Testing info for judges (sandbox buyer login, dashboard password if you set one)

---

## Be ready to explain it
Judges and recruiters may ask how it works. Know these in your own words:
- **PayPal part:** the shop creates a PayPal order on the server, the buyer approves it, the server captures it, and ShipSafe reads the capture (Seller Protection status, countries, address).
- **AI part:** Claude gets the order facts plus the rule signals and returns a score, reasons and a message to the buyer.
- **Security part:** buyer text is treated as untrusted. If someone tries to trick the AI, that counts against them, and the AI can't lower the rule score by more than 15 points.

This is also a strong **portfolio project** for your internship applications, whether or not it wins. Add it to your resume and LinkedIn under Projects.
