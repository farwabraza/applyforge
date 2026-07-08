# ApplyForge — Setup Guide (for the junior 😉)

You'll go from this folder to a live, paid product in ~30 minutes. Same playbook as Ward: GitHub → Render → env var. Plus one new piece: Lemon Squeezy for payments.

---

## Part 1 — Put the code on GitHub (5 min)

1. Go to github.com → **New repository** → name it `applyforge` → Private → Create.
2. On your machine, unzip this folder, then in a terminal inside it:
   ```
   git init
   git add .
   git commit -m "ApplyForge v1"
   git branch -M main
   git remote add origin https://github.com/farwabraza/applyforge.git
   git push -u origin main
   ```
   (Or drag-and-drop the files via GitHub's web uploader if you prefer — works fine, just don't upload `node_modules`.)

## Part 2 — Deploy on Render (10 min)

1. render.com → **New → Web Service** → connect the `applyforge` repo.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free (fine to start; upgrade to Starter later so it doesn't sleep)
3. **Environment → Add Environment Variable:**
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key from console.anthropic.com → API Keys
   
   ⚠️ This is the fix for "engine hiccuped." In the prototype, the API call ran inside the chat sandbox. Here, the key lives on YOUR server and every request goes through it. Never put this key anywhere in the frontend files.
4. Deploy. You'll get `https://applyforge.onrender.com` (rename the service for a nicer URL).
5. Open it. You should see the tracker. Upload your CV in **My Profile** → run a Gap Report → if a report renders, the pipeline works end-to-end.

## Part 3 — Accounts & cloud sync via Supabase (15 min)

This gives users login, protects their data and subscription, and syncs everything across devices. Supabase's free tier covers auth + database with no card.

1. supabase.com → **New project** (any name, set a strong DB password, pick an EU region — Frankfurt — since your users start in Europe).
2. Left sidebar → **SQL Editor** → paste and run exactly this:
   ```sql
   create table user_data (
     user_id uuid primary key references auth.users(id) on delete cascade,
     profile jsonb,
     voice text,
     apps jsonb default '[]',
     answers jsonb default '[]',
     license_key text,
     trial_start timestamptz default now(),
     updated_at timestamptz default now()
   );
   alter table user_data enable row level security;
   create policy "own row only" on user_data
     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```
   The last three lines are the security: every user can only ever see and touch their own row. Non-negotiable — don't skip them.
3. **Authentication → Sign In / Providers → Email**: for a frictionless v1, turn OFF "Confirm email" (users get in instantly). Turn it back on later if you see junk signups.
4. **Settings → API**: copy the **Project URL** and the **anon public** key.
5. Open `public/app.js` — the config block at the top:
   ```js
   const SUPABASE_URL = "https://xxxx.supabase.co";     // ← your Project URL
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";            // ← anon public key
   ```
   The anon key is *designed* to be public — row-level security is what protects data, which is why step 2 matters. Never put the `service_role` key anywhere.
6. Commit + push → Render redeploys → the app now opens with a login wall: "Start free trial."

**What accounts change:** the 3-day trial is now anchored to the account (created server-side), not the device — clearing the browser no longer resets it. The license key is stored in the user's row, so a subscriber logs in on any device and Pro is already active. Profile, tracker, and answer bank sync automatically ~1 second after any change.

**Until you do this part:** the app runs in local-only mode (no login, device storage), so you can test everything else first.

## Part 4 — Payments via Lemon Squeezy (15 min)

Why Lemon Squeezy over Stripe here: it's a Merchant of Record — it handles EU VAT for you (you're in Italy, this matters), and it has built-in **license keys**, which is what the app checks. Zero webhook code needed for v1.

1. app.lemonsqueezy.com → create a store.
2. **Products → New product:**
   - Name: ApplyForge Pro
   - Pricing: **Subscription**, €7 / month
   - Under **License keys**: toggle ON "Generate license keys" (this is the crucial switch)
3. Publish the product → copy its **checkout link** (looks like `https://yourstore.lemonsqueezy.com/checkout/buy/xxxx-xxxx`).
4. Open `public/app.js`, line 4:
   ```js
   const CHECKOUT_URL = "paste-your-checkout-link-here";
   ```
   Commit + push → Render auto-redeploys.

**How the money flow works:** trial ends → paywall appears → user pays via your Lemon Squeezy link → Lemon Squeezy emails them a license key → they paste it into the paywall → the app validates it against Lemon Squeezy's public API → Pro unlocked. If they cancel, the key goes inactive and validation fails.

## Part 5 — Test the whole funnel (5 min)

1. Open the site in a private/incognito window (fresh trial).
2. Upload a CV as PDF → confirm it's read directly (you'll see "✓ using file", never raw text in a box).
3. Paste a job URL → hit Fetch. If the site blocks it (LinkedIn/Indeed do), the app tells the user to paste instead — that's expected behavior, not a bug.
4. Run each tool once: Gap Report, Tailor CV (hit "Download as PDF" — the print dialog produces the formatted document), CV Builder, Cover Letter, Answer Bank, Anything Else.
5. Trial test: DevTools → Application → Local Storage → set `af_trialStart` to `1000` → reload → paywall should block generation.
6. Lemon Squeezy has **Test Mode** — make a test purchase, get a test license key, paste it, confirm Pro activates.

## What's where (so you can direct changes)

| File | What it is |
|---|---|
| `server.js` | The brain: all AI prompts, Anthropic proxy, job-URL fetcher, license check |
| `public/app.js` | All app logic + the `CHECKOUT_URL` config line |
| `public/styles.css` | The entire visual identity |
| `public/index.html` | Shell, nav, profile drawer, paywall |
| `manifest.json` + `sw.js` | PWA: installable, app-like on phones |

## Known v1 limits (honest list)

- **Without Supabase configured**, the trial is device-based and resettable. With accounts on (Part 3), it is anchored server-side.
- **Scanned/image PDFs** can't be read (no OCR). The app detects this and tells the user.
- **Some job sites block URL fetching** — graceful fallback to paste is built in.
- **Uploaded CV files are never stored** — only the structured profile syncs to the account. Keep marketing that as the privacy angle.
- **PDF export uses the browser's print dialog.** Universal and reliable; a one-click .docx export is a good v1.1 upgrade.

## Cost reality check

- Render free tier: €0 (sleeps after inactivity; €7/mo Starter keeps it awake)
- Anthropic API: a full application run (report + CV + letter) ≈ €0.05–0.10 on Sonnet
- Lemon Squeezy: 5% + 50¢ per transaction, no monthly fee
- Break-even: roughly your 2nd subscriber. Everything after is margin.
