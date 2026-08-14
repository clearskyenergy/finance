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

## ⚠️ What actually runs

**`index.html` is the whole application.** It carries the markup, the styles
and the entire app in an inline `<script>`. It does **not** load `app.js` —
there is no `<script src="app.js">` tag anywhere in it.

`app.js` is an earlier, ES5 build of the same portal. Nothing loads it. Most of
the sections below describing an `app.js` / `public/` layout describe that
older build and are kept only as history. **Edit `index.html`.** A change made
to `app.js` will deploy cleanly and do nothing at all.

Two other places where this repo has drifted from the running app, neither
caused by the intake work and both worth a look:

- Sponsors query their organisation's deals with `where('orgKey', '==', …)`,
  but `firestore.rules` grants no read on that basis. The query is refused and
  the failure is swallowed by the per-query error handling in `watchDeals()`,
  so colleagues silently see only their own deals. Decide whether colleagues
  *should* see each other's deals and either add an `orgKey` clause to the read
  rule or drop the query.
- `fin_orgs` (tier and unlock allowances) had no rule at all until this change
  added one. Every read was being refused and every organisation was falling
  back to the default tier.

---

## Repo layout

```
.
├── index.html              # THE APP — markup, styles, and all logic inline
├── firebase-config.js      # your Firebase web config (optional; index.html has a fallback)
├── battery-sizer.html      # standalone storage sizer
├── api/omega-ai-extract.js # serverless utility-bill extraction
├── firestore.rules         # role-based access, intake gate, first-look holds
├── firestore.indexes.json  # composite indexes
├── storage.rules           # project-document upload rules
├── firebase.json           # Firebase Hosting + rules deploy config
├── vercel.json             # Vercel static deploy config
├── app.js                  # DEAD — earlier ES5 build, not loaded by anything
└── README.md
```

---

## Intake gate and first look

A deal no longer necessarily goes straight to the marketplace when a sponsor
files it. Gated technologies — **standalone BESS** by default — stop for an
administrator, who then decides whether to publish it or hold it for one
capital partner first.

```
        sponsor files
              │
      ┌───────┴────────┐
      │ gated tech?    │
      └───┬────────┬───┘
       no │        │ yes
          │        ▼
          │   status: review ──── admin sends back ───▶ status: draft
          │        │
          │   admin approves
          │        │
          │   ┌────┴─────┐
          │   │ hold it? │
          │   └──┬────┬──┘
          │   no │    │ yes
          ▼      ▼    ▼
        status: open  status: exclusive
                        │  held for the first-look partner only
                        │
        ┌───────────────┼────────────────┐
     they pass     they take it      clock runs out
        │               │                │
        ▼               ▼                ▼
   status: open   stays exclusive   status: open
                  (clock stops)
```

### The states

Everything rides on the existing `status` field, because that is what every
query and every rule already keys off:

| `status`    | Who can see it                                    |
|-------------|---------------------------------------------------|
| `draft`     | the sponsor only                                  |
| `review`    | the sponsor and administrators                    |
| `exclusive` | the sponsor, administrators, and the held partner |
| `open`      | every approved capital partner                    |
| `awarded`   | the sponsor, administrators, and the winner       |

### Controls

Everything is configurable from the administrator's **Controls** tab, stored in
`fin_settings/intake` and read live by every client:

| Setting            | Default             | What it does                                   |
|--------------------|---------------------|------------------------------------------------|
| `gateEnabled`      | `true`              | master switch for the review queue             |
| `gateTechs`        | `['bess']`          | which technologies queue for approval          |
| `firstLookOrgKey`  | `amperage-capital`  | which organisation gets first look             |
| `firstLookDays`    | `7`                 | days to accept or reject                       |
| `holdByDefault`    | `true`              | which option the approve dialog pre-selects    |

Non-gated technologies are completely unaffected — they publish on filing
exactly as before. Turning `gateEnabled` off restores the old behaviour for
everything.

### How the hold is enforced

When a hold starts, the uids of every approved capital partner at the
first-look organisation are written onto the deal as `firstLookUids`. That
array is what the partner's listener matches on
(`where('firstLookUids', 'array-contains', uid)`) and what the security rules
test. Keeping it as uids on the document means neither has to read a profile,
and — critically — means every document the query returns is one the rules will
also allow, because Firestore refuses an entire query the moment a single
returned document fails.

The deadline is checked in three places, deliberately:

1. **The UI** hides the take/pass buttons and the offer button once the window
   closes.
2. **The sweep** clears expired holds and moves the deal to `open`.
3. **The rules** refuse a first-look partner's write once `firstLookUntil` has
   passed, compared against `request.time` — the *server's* clock, so moving a
   laptop's clock forward buys nobody an extra day.

### The sweep, and its one limitation

There is no Cloud Function and no cron in this stack, so nothing server-side
wakes up when a window expires. An expired hold is cleared by whichever
signed-in client is entitled to write it — an administrator, or the sponsor who
owns the deal — on each snapshot and on a one-minute timer.

In practice a deal is released within minutes of anyone opening the portal. If
nobody opens it for a day, the deal stays in `exclusive` a day longer than the
window. **It does not stay *theirs*:** the first-look partner's buttons are
gone and the rules refuse their writes the moment the deadline passes, so the
deal is frozen rather than wrongly still on hold.

If that gap matters, the fix is a scheduled Cloud Function running the same
query the sweep runs (`status == 'exclusive'` and `firstLookUntil < now`) and
applying the same patch. `sweepFirstLook()` in `index.html` is the reference
implementation.

### First look and unlock tokens

**A deal held for a partner does not cost them an unlock token.** The hold is
the invitation — charging a token to open something you handed them
exclusively reads as a toll on a favour, and the failure mode is worse than the
principle: a partner out of tokens could not open their own exclusive, the
window would lapse unread, and the deal would reach the marketplace having
never been seen by the one firm it was reserved for.

The exemption is narrow on purpose. It lasts only while the deal is actually
held for them; once it releases — passed, expired, or released by an
administrator — it is metered like anything else unless they spend a token.

If you would rather meter first-look deals too, it is one clause in
`needsToken()` in `index.html`.

### Admin is no longer read-only

The access table below used to say admin had no write access to any project by
design. **That is no longer true** — approving a deal, holding it, releasing
it and sending it back are all administrator writes, so `isFinAdmin()` now has
a scoped `allow update` on `fin_projects`. It is deliberately narrowed: an
administrator cannot change `developerUid` and cannot touch `awardedTo`, so the
operator still cannot award a deal to anybody, including itself. Awarding
remains the sponsor's write alone.

### Deploying the rules

> **`firestore.rules` in this repo is stale — do not deploy it.** Checked
> against the live rules on 13 Aug 2026, it is missing eight production
> collections (`dashboard_layouts`, `termsAcceptances`, `omega_contracts`,
> `org_members`, `omega_staff`, `intake_projects`, `intake_requests`,
> `equipment`) and fifteen helpers. Deploying replaces the whole database's
> rules, so pushing it would delete them — and losing `termsAcceptances`
> stops every user on every tenant from signing in, because that gate fails
> closed.
>
> The financing changes are written up as a patch against the live file in
> **`firestore.rules.PATCH.md`**. Apply that instead.


`firestore.rules` covers *every* portal sharing the `clearsky-portal`
database, and deploying it replaces the whole database's rules. Given the
drift noted at the top of this file, **diff it against what is live before you
deploy** rather than pushing it blind — the financing blocks here are current,
but other portals' blocks may have moved on since this file was last touched.

The financing changes are confined to:

- a new `match /fin_settings/{docId}` block
- a new `match /fin_orgs/{orgKey}` block
- the `match /fin_projects/{projectId}` block, which now also contains a
  nested `match /fin_views/{orgKey}` block
- a new top-level `match /{path=**}/fin_views/{orgKey}` block — the
  collection-group read the sponsor's cross-book query needs, which the nested
  rule does **not** provide

`array-contains` on a single field (the first-look query) and the
collection-group read on `sponsorOrgKey` both use Firestore's automatic
single-field indexing, so no composite index is required. If a first read
returns `failed-precondition`, the browser console carries a one-click link to
create the index; the portal reports that in the panel rather than showing an
empty box.

---

## View tracking — what the capital side has actually looked at

A sponsor filing into a marketplace is otherwise working blind: they cannot
tell the difference between *nobody wants this* and *nobody has seen it*. The
portal records capital-side engagement and reports it back as a funnel.

```
   viewed  ──▶  unlocked  ──▶  watching  ──▶  offered
```

| Signal     | Recorded when                                              |
|------------|------------------------------------------------------------|
| viewed     | a capital partner opens the deal drawer                    |
| unlocked   | they spend a token on the full file                        |
| watching   | somebody at that firm adds it to their watchlist           |
| offered    | already tracked on the deal                                |

### Where sponsors see it

- **Overview → "Who is looking"** — the funnel across their whole book, the
  typical time to first view, and a list of deals **nobody has opened**, which
  is usually the most actionable number on the page.
- **Deal drawer → Interest tab** — per deal: which firms, how many opens,
  first and last, and how far each got.
- **Deal table → "Viewed by" column** — sortable, so the coldest deals can be
  brought to the top.
- **Export my book** — readership columns are added to the CSV.

### Recorded by firm, never by individual

One document per organisation per deal, at
`fin_projects/{dealId}/fin_views/{orgKey}`:

```
orgKey, org              which firm looked
sponsorOrgKey            whose deal it is — lets the sponsor read across their
                         whole book in one collection-group query
views, firstAt, lastAt   open count and window
unlockedAt, watchedAt    the stronger signals
```

*"Amperage Capital opened this twice"* is deal intelligence. *"Ada opened it at
11pm on Sunday"* is surveillance of an individual, tells the sponsor nothing
more useful, and would make partners browse warily. No individual's name and no
individual's timestamp is ever written to these records or shown to a sponsor.

Repeat opens by the same firm inside **30 minutes** fold into the existing
record rather than inflating the count. The count uses an atomic
`FieldValue.increment`, so two people at the same firm opening a deal
simultaneously cannot overwrite each other with a stale read.

Not recorded: a sponsor reading their own file, an administrator doing their
rounds, or a sample record.

### Named or counted — your call

Under **Controls → View tracking**:

| Setting  | A sponsor sees                                  |
|----------|-------------------------------------------------|
| `named`  | "Amperage Capital opened this twice" *(default)* |
| `counts` | "3 capital partners have opened this"           |

Naming firms lets a sponsor follow up with whoever is circling, which is most
of the value. Counts-only keeps a partner's pipeline interest private, at the
cost of the sponsor not knowing who to call. The setting changes what sponsors
are *shown*; the same data is recorded either way.

### The privacy boundary

A capital partner must never see this data about a rival — which firms are
circling a deal is precisely what these records contain. Enforced in four
places:

- The Interest tab is not offered on a deal they do not own.
- The "Viewed by" column is not in their table.
- Their CSV export carries no readership columns.
- The rules let a partner read only their **own** firm's record — the document
  id *is* their organisation key, so there is no path on which one firm can
  read, write or inflate another's.

### What it needs deployed

- The `match /fin_views/{orgKey}` block nested under `fin_projects` (writes).
- The `match /{path=**}/fin_views/{orgKey}` block (the sponsor's
  collection-group read). A collection-group query is **not** authorised by the
  nested rule — it needs a rule matched at the group path, which is why both
  exist.
- Firestore creates the single-field collection-group index automatically. If
  the first read returns `failed-precondition`, the browser console will carry
  a one-click link to create it; the portal shows that as a message in the
  panel rather than an empty box.

The subcollection is named `fin_views` rather than `views` because that
wildcard reaches across the whole shared database, and a bare `views` would
match any other portal's data.

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
  status ("draft" | "review" | "exclusive" | "open" | "closed" | "awarded"),
  offerCount,
  awardedTo (partner uid | null), awardedToOrg (string | null),
  docs { sitemap:{name,url,path}, cost:{...}, proforma:{...} },
  links [ { label, url } ],                      # cloud share links
  createdAt, updatedAt

  # --- intake gate (set when an administrator approves) ---
  approvedAt, approvedBy
  reviewNote, reviewedAt, reviewedBy             # set when sent back to the sponsor

  # --- first-look hold ---
  firstLookUids [ uid, … ]        # partners who hold it; empty when not held
  firstLookOrgKey, firstLookOrgName
  firstLookDays                   # window granted, for the audit trail
  firstLookStartedAt, firstLookUntil        # epoch ms; the deadline
  firstLookDecision ("accepted" | "passed" | "released" | "expired" | null)
  firstLookDecidedAt, firstLookDecidedBy
  firstLookPastUids [ uid, … ]    # who held it, kept after release

fin_settings/intake                              # administrator-controlled
  gateEnabled, gateTechs [ techId, … ],
  firstLookOrgKey, firstLookOrgName, firstLookDays, holdByDefault,
  viewerDisclosure ("named" | "counts"),
  updatedAt, updatedBy

fin_projects/{projectId}/fin_views/{orgKey}      # one doc per FIRM per deal
  orgKey, org                    which capital firm looked
  sponsorOrgKey                  whose deal it is — lets the sponsor read
                                 across their whole book in one
                                 collection-group query
  views, firstAt, lastAt         open count and window
  unlockedAt                     they spent a token on the full file
  watchedAt                      somebody there is watching it
  # No individual's name or timestamp is ever written here. See "View
  # tracking" above for why.

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
| Submit a deal                      | ✅                     | —                             | ✅           |
| See own submissions                | ✅                     | —                             | ✅ (all)     |
| See all open deals                 | own only               | ✅                            | ✅           |
| See a deal in the review queue     | own only               | —                             | ✅           |
| See a deal on first-look hold      | own only               | only the holder               | ✅           |
| See a deal awarded to someone      | if party               | if winner                     | ✅           |
| Approve a deal onto the portal     | —                      | —                             | ✅           |
| Hold a deal for the first-look partner | —                  | —                             | ✅           |
| Release a hold early               | —                      | holder (by passing)           | ✅           |
| Take or pass a first look          | —                      | ✅ (holder, in window)        | —            |
| Upload files                       | ✅ (own, pre-award)    | —                             | —            |
| Add / edit cloud links             | ✅ (own, pre-award)    | —                             | —            |
| Open files and links               | ✅ (own)               | ✅ (visible deals)            | ✅           |
| Make / update an offer             | —                      | ✅ (open, or held for them)   | —            |
| Accept an offer → award & lock     | ✅                     | —                             | —            |
| Reject an offer                    | ✅                     | —                             | —            |
| Recall an offer                    | —                      | ✅ (own)                      | —            |
| Post an inquiry                    | ✅ (own deal)          | ✅ (visible deals)            | — (read-only)|
| See who has viewed a deal          | ✅ (own deals)         | own firm's record only        | ✅           |
| Export readership data             | ✅ (own deals)         | —                             | ✅           |
| Spreadsheet view + CSV export      | —                      | —                             | ✅           |

**Admin write access is scoped, not blanket.** An administrator may move a deal
through the intake states and may not change `developerUid` or `awardedTo` —
awarding stays the sponsor's decision alone.

The **first-look partner** has exactly two writes on a project, both pinned
with `hasOnly()` so they cannot reach any other field: stamping
`firstLookDecision: 'accepted'` while the window is live, and passing, which
sets the deal to `open` and empties `firstLookUids`.

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
- **Amperage Capital** onboards as `partner` accounts. Once at least one of
  their accounts is approved under **People**, set them as the first-look
  partner under **Controls** — the `orgKey` is derived from the organisation
  name they register with, so `Amperage Capital` becomes `amperage-capital`.
  A hold is written against the accounts approved *at the time it starts*, so
  approve their people before you hold a deal for them.
- **Scheduled release of expired holds:** see "The sweep, and its one
  limitation" above. A Cloud Function on a schedule removes the dependency on
  somebody having the portal open.
- **Notify on a hold:** a Cloud Function on `fin_projects` writes could email
  the first-look partner the moment a deal is held for them, rather than
  relying on them signing in during the window.
- **XLSX export:** the CSV path is `exportAdminCsv()` in `app.js`. Swapping in
  SheetJS from a CDN would give a real `.xlsx` with typed number columns; the
  `ADMIN_COLS` / `ADMIN_CSV_EXTRA` definitions already carry everything needed.
- **Server-side admin queries:** the admin console currently pulls the whole
  `fin_projects` collection to the browser and filters there. That is fine into
  the low thousands of deals; past that, move filtering into Firestore queries
  or a Cloud Function.
