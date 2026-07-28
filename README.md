# ClearSky-OMEGA · Financing Partners Portal

A Firebase-backed deal room where **developers** and **originators** submit
permit-ready energy deals (numbers + documents + cloud links) and **capital
partners** review the open pipeline, then **offer, accept, reject, or inquire**.
**Admins** see every deal in a filterable spreadsheet and export it to CSV.
When a deal is awarded it **locks** — it drops off every other partner's board
and persists only as a project name.

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
fin_profiles/{uid}
  name, org, email, emailLower,
  role ("developer" | "originator" | "partner" | "admin"),
  allowlisted, createdAt

fin_projects/{projectId}
  name, type, capacityKw, costBasis, proformaSummary, location, notes,
  developerUid, developerOrg, developerName,     # owner — any submitter role
  submitterRole ("developer" | "originator"),    # how they submitted it
  submitterEmail,
  status ("open" | "closed" | "awarded"),
  offerCount,
  awardedTo (partner uid | null), awardedToOrg (string | null),
  docs { sitemap:{name,url,path}, cost:{...}, proforma:{...} },
  links [ { label, url } ],                      # cloud share links
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

| Capability                         | Developer / Originator | Partner                       | Admin        |
|------------------------------------|------------------------|-------------------------------|--------------|
| Submit a deal                      | ✅                     | —                             | —            |
| See own submissions                | ✅                     | —                             | ✅ (all)     |
| See all open deals                 | own only               | ✅                            | ✅           |
| See a deal awarded to someone      | if party               | if winner                     | ✅           |
| Upload files                       | ✅ (own, pre-award)    | —                             | —            |
| Add / edit cloud links             | ✅ (own, pre-award)    | —                             | —            |
| Open files and links               | ✅ (own)               | ✅ (visible deals)            | ✅           |
| Make / update an offer             | —                      | ✅ (pre-award, one per partner)| —            |
| Accept an offer → award & lock     | ✅                     | —                             | —            |
| Reject an offer                    | ✅                     | —                             | —            |
| Recall an offer                    | —                      | ✅ (own)                      | —            |
| Post an inquiry                    | ✅ (own deal)          | ✅ (visible deals)            | — (read-only)|
| Spreadsheet view + CSV export      | —                      | —                             | ✅           |

**Admin is deliberately read-only.** It can see every deal in the marketplace
but the rules grant it no write access to any project, offer, or inquiry.

The **award transaction** (`acceptOffer` in `app.js`) flips the project to
`awarded`, stamps `awardedTo`, marks the winning offer `accepted`, and rejects
all other pending offers. Once `status == "awarded"`, the rules stop returning
the project to any partner except the awardee — the app also shows a **sealed**
placeholder if a stale link is opened.

---

## Roles

| Role         | How it's granted                              |
|--------------|-----------------------------------------------|
| `developer`  | Self-select at signup                         |
| `originator` | Self-select at signup                         |
| `partner`    | Active `partnerAllowlist` entry, `role: "partner"` |
| `admin`      | Active `partnerAllowlist` entry, `role: "admin"`   |

`developer` and `originator` have identical permissions — the split exists so
you can tell a builder's own project from sourced deal flow, and so the copy
reads correctly on each side. Both write `developerUid` as the owner field
(which is what the rules key off) plus a `submitterRole` field for reporting.

### Adding an admin

Create or edit a doc in the shared `partnerAllowlist` collection:

```
partnerAllowlist/{email-lowercased}
  active: true
  role:   "admin"
  partner account: "ClearSky Builders"   # optional, overrides typed org name
```

Then have them register at `/?mode=register` with that exact email. The
allowlist role always wins over whatever they pick on the form. Roles are
immutable after signup — to change one, edit the profile doc directly in the
Firebase console.

### Cloud links

Every deal carries a `links` array of `{ label, url }`. The submit form seeds
two rows — *Utility bills* and *Site details* — and more can be added with any
label. Only `http://` and `https://` URLs are accepted or rendered; anything
else is rejected at save time and again at render time, so a pasted
`javascript:` URL can never become a live anchor.

Links are just URLs — the portal does not proxy them. If a Drive or SharePoint
link is set to "restricted", partners will hit a permission wall rather than the
file. The form says so, but it's worth repeating to submitters.

### Admin console

Signing in as `admin` replaces the card grid with a sortable spreadsheet:
search across names, people, orgs, locations and notes; dropdown filters for
submitter, role and deal type; the existing status tabs still apply. **Export
CSV** writes whatever is currently on screen, including every file URL and a
flattened `label: url` column for the cloud links. The export is UTF-8 with a
BOM so Excel opens it cleanly, and cells beginning `=`, `+`, `-` or `@` are
prefixed with an apostrophe to defuse spreadsheet formula injection.

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
- **XLSX export:** the CSV path is `exportAdminCsv()` in `app.js`. Swapping in
  SheetJS from a CDN would give a real `.xlsx` with typed number columns; the
  `ADMIN_COLS` / `ADMIN_CSV_EXTRA` definitions already carry everything needed.
- **Server-side admin queries:** the admin console currently pulls the whole
  `fin_projects` collection to the browser and filters there. That is fine into
  the low thousands of deals; past that, move filtering into Firestore queries
  or a Cloud Function.
