# Beta launch proposal

**DRAFT. Not legal advice.** This is a plan only. Nothing here was purchased, deployed, or turned on.

Prices below were read from vendor pages in October 2026. Confirm them on the vendor’s own pricing page before paying anyone. A 50-person beta is a small amount of traffic: one Node process, short bursts of image work, and scan storage measured in tens of gigabytes, not a cluster.

The rule for this project still holds: scan images and assisted-correction examples do not leave the home network until accounts, a recorded consent, and a published privacy policy all exist. Do not point TestFlight testers at a public server before that.

## a) Hosting the Node server

The app is one Node process (`server.js`) plus files on disk (`data/`, `uploads/`, `scans/`). Grading uses `sharp` on a still that can be a phone photo or a flatbed scan. Give the process at least 1 GB of RAM. A 512 MB instance may be too small for a 12 MP still; that was not measured on a hosted machine, so try one real scan before committing to the smallest size.

At roughly 50 testers the machine is idle most of the time. Budget for one always-on process, a hostname with normal HTTPS, and object storage for the images. A database server is not required yet: `data/database.json` is the inventory.

### Render

- **Shape.** One web service on Render’s Hobby workspace. The published Starter size is 0.5 CPU / 512 MB at **$7/month**. There is no separate workspace fee on Hobby.
- **Why it fits.** The bill is a fixed size, which is easy to predict. Render terminates HTTPS.
- **Why it may not.** 512 MB is the size most likely to run out of memory on a large still. The next published web-service size is a large jump (Standard is listed around $25/month). Outbound bandwidth on the free workspace includes about 5 GB, then about $0.15/GB.
- **At 50 testers.** About **$7/month** if Starter survives real scans, or about **$25/month** if you have to step up. Image bytes should not live on the instance disk (see R2 below).

### Fly.io

- **Shape.** One Machine, no monthly plan fee. Published figures for a `shared-cpu-1x` Machine are about **$2–4/month** at 256–512 MB if it runs all month, depending on region (about $3.32–$3.69 for 512 MB in the cheaper regions). A 1 GB Machine is roughly double that.
- **Why it fits.** You can pick 1 GB without buying a much larger plan, and you can put the Machine in a region near the testers.
- **Why it may not.** Billing is per second plus storage plus egress (about $0.02/GB in North America and Europe). There is no spending cap. Volume storage is extra (about $0.15/GB-month) if the JSON inventory stays on a disk.
- **At 50 testers.** About **$5–10/month** for a 1 GB Machine with a small disk, before R2. Watch the bill; Fly will not stop itself.

### Railway

- **Shape.** Hobby plan **$5/month**, and that $5 is usage credit. Published rates are about $10 per GB of RAM per month and $20 per vCPU per month, plus $0.05/GB egress.
- **Why it fits.** A half-gigabyte process that is actually idle can land near the $5 credit. Deploy is a git push.
- **Why it may not.** A 1 GB process that stays up all month is about $10 of RAM before CPU, so the bill is higher than the $5 plan fee. Usage pricing is harder to predict than Render’s sticker price.
- **At 50 testers.** About **$5–15/month** for the process. Same note as the others: put images in R2, not on the service disk.

### A small VPS

- **Shape.** One virtual machine you administer (Hetzner, DigitalOcean, or similar), 1–2 GB RAM. Public list prices for that class are commonly about **$4–12/month**. Confirm the current SKU; this proposal does not lock a vendor.
- **Why it fits.** One box is closest to the iMac you already run: a directory on disk, a process you restart, no platform timeout. Predictable.
- **Why it may not.** You install Node, TLS, and updates yourself. The machine is a pet, like the iMac, unless you write that down.
- **At 50 testers.** About **$4–12/month** plus the domain (a domain is often about $10–15/year). R2 is still the right place for scan bytes so the VPS disk is not the archive.

### Image storage (Cloudflare R2)

Plan on R2 for flatbed scans and phone stills. Published Standard storage is **$0.015 per GB-month**. Egress to the internet is free. Class A writes are $4.50 per million requests; Class B reads are $0.36 per million. The free tier includes 10 GB-month, 1 million Class A, and 10 million Class B.

Fifty testers, if each keeps 30 scans at about 8 MB (a mix of phone JPEGs and flatbed files), is about 12 GB. That is inside or just past the free 10 GB, so storage is about **$0–1/month**. Operations for a beta of this size stay inside the free request tier unless something loops. The app does **not** speak R2 yet. Moving images off the local `uploads/` and `scans/` directories is work that still has to be built, after the privacy gates below.

Do not put assisted-correction examples (`data/centering_examples.jsonl`) in R2. Rows with consent turned off stay on the machine that recorded them. Rows with consent turned on also stay there until accounts, consent, and a privacy policy exist. `examplesClearedToLeave()` returns an empty list on purpose.

### What moving off the iMac requires

The iMac is the whole product today: `npm start` / `npm run start:lan`, files under the checkout, a self-signed certificate for the phone, and `scripts/push_scan_data.sh` copying scans to a private GitHub repo. A hosted beta replaces the first part and must not widen the second.

1. A hostname and a normal TLS certificate (the host can issue it). Phones will not keep trusting the iMac’s self-signed cert.
2. A process manager so Node restarts (the platform, or systemd on a VPS).
3. Persistent storage for `data/database.json`, `failed_scans.jsonl`, `scan_labels.json`, and `test_deck.json`. Those files are the inventory. An ephemeral disk will forget grades.
4. R2 (or an equivalent bucket) for `uploads/` and `scans/`, plus a code change to read and write them. That change is not in this proposal’s build.
5. Environment variables for the data directory and, later, the bucket keys. Keys stay out of git.
6. Enough RAM for `sharp` (start at 1 GB).
7. A decision to stop using the iMac as the URL testers open. The LAN certificate flow (`/lan-ca.cer`) is for the house, not for TestFlight.
8. Leave `centering_examples.jsonl` and `assist_settings.json` off every copy. `push_scan_data.sh` already skips them and strips the user’s millimetre line out of the database copy. Do not point that script at tester scans. It already pushes your own scan archive to GitHub, which is off the home network.

Nothing in this list should be bought or migrated until section (c) is actually published and accounts from section (b) are on.

## b) Accounts

Testers need an account before their scans are allowed to leave the house. The account is who the deletion request in the privacy policy belongs to.

Options:

| Option | What the tester does | What you take on | Fit for this beta |
| --- | --- | --- | --- |
| Sign in with Apple | The system sheet. TestFlight users already have an Apple ID. | An App ID with the Sign in with Apple capability, a Services ID if the web app uses it later, and a server check of Apple’s token. No passwords. | Best match for the iOS TestFlight beta. |
| Email magic link | They type an email, open a link. | You store email addresses and send mail (a mail provider, a from-address, bounce handling). | Right second step for the web app, once the privacy policy is up. |
| Email and password | They invent a password. | You store a password hash, reset flow, and breach duty. | Worse than a magic link. Do not start here. |
| “Log in” as it works today | A username, no password, no identity. | Nothing, and no way to know whose scan it is. | Not an account. Do not use it for testers. |

**Recommendation for the iOS TestFlight beta:** Sign in with Apple, and do not add a second social login. Apple’s review rules expect Sign in with Apple if you offer other third-party logins; skipping those avoids that requirement and avoids a password database. The web client can gain email magic link later, sharing the same account id, once the privacy policy URL exists. Until the account check is real, the beta server stays on the home network.

Company grades stay separate from this. An account does not merge PSA, BGS, SGC, CGC, or TAG grades, and an assisted centering line is not a grade from any of those companies.

## c) Consent and privacy

**DRAFT privacy policy. Not legal advice.** Have a lawyer read it before it is published or linked from App Store Connect. It is written in plain English so a tester can see what the app does.

---

### Privacy policy (draft)

**The Judge** is a card-grading aid. It runs on a server the operator controls. This draft says what that server stores. It is not a promise from a lawyer, and it is not in effect until the operator publishes it at a real URL.

**Who we are.** The operator of The Judge (the person who invited you to the beta). Contact: the email address published next to this policy.

**Scan images.** When you capture or upload a card, the app sends that image to the server so it can find the card and measure it. The server stores the image, a straightened copy of the card, and the measurements it computed. Those files exist so you can look at the grade again. They are not sold. They are not sent to a grading company. They are not used to train a model unless you turn on “Help improve The Judge,” and even then only the correction described below is eligible — the scan image itself is not copied into that correction file.

**Measurements.** Lengths are stored in millimetres. If the program measured a border, that number is an engine measurement. If you dragged a line, that number is yours. It is labelled assisted. It does not replace the engine’s number. A grade shown from a line you dragged is labelled assisted. It is not a PSA, BGS, SGC, CGC, or TAG grade.

**Assisted-correction examples.** If you drag a border line, the server stores an example: the scan id, the side, any candidate lines the engine had, your line in millimetres, the engine version and commit, and a consent flag. The flag is off unless you have turned on “Help improve The Judge” before you save. Examples with consent off stay on the device or on that server. They are not copied to a hosted bucket, a scan archive, or anywhere else. Turning the setting on does not change examples you already saved. You can ask for those examples to be deleted even if consent was on.

**Accounts.** When accounts exist, the scan is tied to the Apple ID (or, later, the email) you signed in with, so a deletion request can find your rows. Until then, the server is only for use on the home network.

**What we do not do.** We do not sell personal information. We do not put advertising trackers in the app. We do not send your scans to a grading company. We do not treat an assisted line as the engine’s measurement.

**How long we keep it.** Scans and examples stay until you ask us to delete them or you delete the card in the app, once that control exists. Backups, if any, are deleted on the same request as the live copy.

**Deletion requests.** Email the contact address above from the same address as your account, or from the address you used for TestFlight, and say which scans or examples to delete. Ask for “everything” if you want the account, the images, the grades, and the correction examples removed. We will delete them from the live server and from any copy we made. We will write back when that is done. A request does not delete a grade that a grading company issued; we do not hold those.

**Children.** The beta is not for anyone under 16.

**Changes.** If this text changes, the date at the top changes, and the app will point at the new URL.

---

Publish that text at a stable HTTPS URL before App Store Connect will accept it. A page on the future host is enough. Do not mark the page as legal advice.

The in-app control that matches this draft is already on the web client: Settings → “Help improve The Judge,” default off.

## d) TestFlight external testing

External testers are people who are not users on the App Store Connect team. Apple’s current TestFlight flow, from the App Store Connect help on inviting external testers:

1. An Apple Developer Program membership. The public enrollment price has been US$99 per year; confirm it on Apple’s enrollment page before paying.
2. An app record in App Store Connect (bundle id, name, SKU).
3. A build uploaded from Xcode (or Transporter). The build has to be processed before it can be offered.
4. Export compliance. Answer the encryption questions. HTTPS to your own server is usually the standard “uses encryption / exempt” path; confirm against the questions Apple shows for that build.
5. An internal group first is the practical way to see the build install. Internal testers are App Store Connect users and do not need Beta App Review. External testers do.
6. Test information for Beta App Review: what to test, a description, an email address testers can reply to, and a contact phone. The first build of a version gets a full review. Later builds of the same version sometimes do not. You can submit up to six builds for TestFlight review in a day.
7. A **privacy policy URL** in the app’s metadata. Apple requires it for the iOS app, and the policy has to say what is collected, how, what it is used for, and that people can ask for deletion. The draft in section (c) is the text to put at that URL after a lawyer has seen it. The URL must load. Placeholder pages are a rejection reason.
8. A sign-in path Apple can use, if the app requires an account. A demo account in the review notes, or Sign in with Apple that the reviewer can complete. A server that only answers on a home LAN will fail review and will fail every external tester.
9. Up to 10,000 external testers, invited by email or by a public link. A public link can cap the number of testers. Builds expire after 90 days.
10. TestFlight cannot be used to pay testers or to deliver a paid beta.

The build must also show the privacy policy inside the app, not only in App Store Connect.

External testing is pointless until the server in section (a) is reachable on the public internet **and** sections (b) and (c) are done. Internal testing on the home Wi-Fi can happen earlier, with the iMac and the self-signed certificate, and with no scans leaving the house.

## e) Who does what

### Cursor builds (code, no accounts, no spend)

1. Web manual centering assist (this change): drag a line, store millimetres, label the result assisted, keep the engine number, store examples with consent defaulting to off.
2. The same assist on the iOS client, talking to that home server.
3. Sign in with Apple on the server and in the iOS app, behind a flag that stays off until you have the Apple key and the privacy policy URL.
4. Email magic link for the web client, same flag.
5. A deletion request that removes one account’s scans, grades, and `centering_examples.jsonl` rows, including backups the code knows about.
6. The R2 read/write path for new scans, still writing to local disk when the bucket is not configured, so the iMac keeps working.
7. A privacy-policy page route that serves the text you approved, once you say the draft is allowed to be published.
8. TestFlight-facing copy inside the app: the policy link, and grades labelled assisted when a line was dragged. No company grade is invented.

### You do by hand (accounts, payments, approvals)

1. Decide that the draft privacy policy is ready for a lawyer, and pay the lawyer if you want one. Do not publish the draft as if it were finished legal advice.
2. Enroll in the Apple Developer Program and pay Apple.
3. Create the App Store Connect app, the bundle id, and the Sign in with Apple capability on the App ID.
4. Create the Render, Fly, Railway, or VPS account only when you are ready to leave the house, and pay that bill. Create the Cloudflare account and the R2 bucket the same day, not before.
5. Buy the domain if you want a stable privacy-policy URL, and put the approved policy at `https://that-domain/privacy`.
6. Paste that URL into App Store Connect. Fill in TestFlight’s “what to test,” feedback email, and phone.
7. Upload a build (or let a later change’s archive be uploaded) and submit the first build to Beta App Review. Answer the export question.
8. Create the external tester group and send invites only after a scan from a non-LAN phone stores an image, an assisted example with consent off stays off the bucket, and a deletion request removes both.
9. Keep running the iMac for your own deck until that checklist is true. Do not run `push_scan_data.sh` on tester data.

## Suggested order

1. Keep using the iMac. Assisted lines stay in `data/centering_examples.jsonl`.
2. Lawyer, then publish the privacy policy.
3. Accounts (Sign in with Apple) and deletion, still on the iMac.
4. Only then: host, R2, public HTTPS, TestFlight external review.

Until step 4, external testers are not invited, and no correction example leaves the home server.
