# ClearSky-OMEGA · Financing Partners Portal

A Firebase-backed deal room where **developers** submit permit-ready energy
projects (site map + cost basis + pro forma) and **capital partners** review the
open pipeline, then **offer, accept, reject, or inquire**. When a project is
awarded it **locks** — it drops off every other partner's board and persists only
as a project name.

Built to ClearSky house style: **single-file ES5** app logic, **Firebase compat
(v8) SDK** from the gstatic CDN, deployed via **GitHub → Vercel** (or Firebase
Hosting). No build step, no bundler, no local tooling required.

---

## Repo layout

```
.
├── public/
│   ├── index.html          # static shell (auth view + app view + modals)
│   ├── firebase-config.js  # your Firebase web config (edit this)
│   └── app.js              # all application logic (ES5)
├── firestore.rules         # role-based access + award-lock enforcement
├── firestore.indexes.json  # composite indexes for the queries used
├── storage.rules           # project-document upload rules
├── firebase.json           # Firebase Hosting + rules deploy config
├── vercel.json             # Vercel static deploy config
├── .gitignore
└── README.md
```

> **Vercel note:** Vercel serves the repo root by default. This scaffold puts the
> web app in `public/`. Either set the Vercel **Output/Root Directory** to
> `public`, or move `index.html`, `firebase-config.js`, and `app.js` to the repo
> root and drop the `public/` folder. `firebase.json` already points Firebase
> Hosting at `public/`.

---

## Data model (Firestore)

```
users/{uid}
  name, org, email, role ("developer" | "partner"), createdAt

projects/{projectId}
  name, type, capacityKw, costBasis, proformaSummary, location, notes,
  developerUid, developerOrg, developerName,
  status ("open" | "offered" | "awarded"),
  offerCount,
  awardedTo (partner uid | null), awardedToOrg (string | null),
  docs { sitemap:{name,url,path}, cost:{...}, proforma:{...} },
  createdAt, updatedAt

projects/{projectId}/offers/{offerId}      # offerId == partnerUid (one per partner)
  partnerUid, partnerOrg, partnerName,
  amount, structure ("debt"|"tax_equity"|"acquisition"|"long_hold"),
  terms, holdYears,
  status ("pending" | "accepted" | "rejected" | "recalled"),
  createdAt

projects/{projectId}/inquiries/{msgId}
  authorUid, authorName, authorRole, body, createdAt
```

Project documents are stored in **Firebase Storage** under
`projects/{projectId}/{fileName}`; the download URL is written back into the
project's `docs` map.

---

## Access model (enforced by `firestore.rules`)

| Capability                         | Developer            | Partner                       |
|------------------------------------|----------------------|-------------------------------|
| See own submissions                | ✅                   | —                             |
| See all open / offered projects    | own only             | ✅                            |
| See a project awarded to someone   | if party             | if winner                     |
| Upload site map / cost / pro forma | ✅ (own, pre-award)  | —                             |
| Make / update an offer             | —                    | ✅ (pre-award, one per partner)|
| Accept an offer → award & lock     | ✅                   | —                             |
| Reject an offer                    | ✅                   | —                             |
| Recall an offer                    | —                    | ✅ (own)                      |
| Post an inquiry                    | ✅ (own project)     | ✅ (visible projects)         |

The **award transaction** (`acceptOffer` in `app.js`) flips the project to
`awarded`, stamps `awardedTo`, marks the winning offer `accepted`, and rejects
all other pending offers. Once `status == "awarded"`, the rules stop returning
the project to any partner except the awardee — the app also shows a **sealed**
placeholder if a stale link is opened.

---

## Setup

### 1. Create / choose a Firebase project
Reuse `clearsky-portal` or create a new project. Enable:

- **Authentication** → Sign-in methods → **Email/Password** and **Google**
- **Firestore Database** (production mode)
- **Storage**

### 2. Add your web config
In the Firebase console: **Project settings → General → Your apps → Web app →
SDK setup and config**. Copy the values into `public/firebase-config.js`:

```js
var firebaseConfig = {
  apiKey: "…",
  authDomain: "clearsky-portal.firebaseapp.com",
  projectId: "clearsky-portal",
  storageBucket: "clearsky-portal.appspot.com",
  messagingSenderId: "…",
  appId: "…"
};
```

> These web-config values are **not secret** — they ship to the browser by
> design. Real security is in the Firestore and Storage rules.

### 3. Deploy rules & indexes
Install the Firebase CLI (`npm i -g firebase-tools`), then:

```bash
firebase login
firebase use clearsky-portal        # or your project id
firebase deploy --only firestore:rules,firestore:indexes,storage
```

The composite indexes may also be created on demand — the first time a query
runs, the Firebase console will surface a one-click "create index" link.

### 4. Authorize your domains
**Authentication → Settings → Authorized domains** — add your Vercel domain
(e.g. `financing.csebuilders.com`) and `localhost` for local testing.

### 5. Deploy the app

**Vercel (GitHub flow):** push this repo, import it in Vercel, set the root/output
directory to `public/`, deploy. Point `financing.csebuilders.com` at it.

**or Firebase Hosting:**
```bash
firebase deploy --only hosting
```

---

## Local development

No build step. Serve the `public/` folder over http (not `file://`, so auth
popups and the SDK work):

```bash
cd public
python3 -m http.server 5173
# open http://localhost:5173
```

The `?mode=register` deep link opens straight to the sign-up form — this matches
the CTA links on the marketing page (`financing.html`).

---

## House-style constraints (do not break)

- **ES5 only** in `app.js`: no arrow functions, no template literals, no
  `let`/`const`, no optional chaining, no `async`/`await`.
- **Single-file** app logic (`app.js`) + **static shell** (`index.html`).
- **Firebase compat v8** loaded from `gstatic` CDN in `index.html`.
- All colors via CSS variables; brand chrome consistent with ClearSky-OMEGA.

---

## Linking from the platform

Point the **Financing Partners** card in `platform.html` (currently `SOON`) and
the nav item at the marketing page `financing.html`, whose register/login CTAs
send users to this portal at `https://financing.csebuilders.com/?mode=register`
(or `mode=login`). Swap that host if you deploy under a different subdomain.

---

## Roadmap hooks

- **SiteMap Designer handoff:** the `docs.sitemap` slot is where an OMEGA export
  (base64 or Storage upload) lands — wire the export hook to `doUploadFiles`.
- **Notifications:** add a Cloud Function on `offers` / `inquiries` writes to
  email the counterparty.
- **Stricter Storage rules:** front uploads with a Cloud Function that verifies
  the caller owns the project, or encode `developerUid` into the storage path.
- **Amperage Capital** and other launch partners onboard as `partner` accounts.
