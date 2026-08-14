# Financing patch — apply to your LIVE rules, not to `firestore.rules` in this repo

`firestore.rules` in this repo is **stale**. Your live rules carry eight
collections it has never heard of. Deploying the repo file would delete them.

**Do not deploy `firestore.rules` from this repo.** Apply the six edits below to
your live file instead. Everything here uses your idioms — `blocked()`,
`hasFinProfile()`, `finOrgKey()`, `isOmegaStaff()` — rather than the parallel
helpers the repo copy invented.

Worst case if you deploy the repo file anyway: `termsAcceptances` disappears,
the acceptance write returns `permission-denied`, the modal never clears, and
**nobody signs in to any tenant.** Your own comment in the live file says so.

---

## Edit 1 — new collection: `fin_settings`

The intake gate, the first-look partner, the window length and the view
disclosure setting. Every client reads it; only the operator writes it.

Insert next to the other `fin_*` blocks:

```
    /* Intake gate and first-look defaults. Read by every client so a newly
       filed deal lands in the right state and a held deal is labelled
       correctly; written only by the marketplace operator. */
    match /fin_settings/{docId} {
      allow read:  if signedIn();
      allow write: if isAdmin() || (hasFinProfile() && isFinAdmin());
    }
```

---

## Edit 2 — `fin_projects`: two helpers

Add inside `match /fin_projects/{projectId}`, next to `isOwner()`:

```
      /* The first-look partner. Membership is an array of uids written onto
         the deal when the hold starts, so this resolves without a profile
         read — and so a partner's array-contains query returns only
         documents this same test passes. Deliberately not gated on status:
         the query cannot filter on status too, and every document carrying
         the uid is one this partner was given. */
      function isFirstLook() {
        return isPartner()
               && request.auth.uid in resource.data.get('firstLookUids', []);
      }
      /* Is the exclusive window still running? Against the SERVER clock, so
         moving a laptop's clock forward buys nobody an extra day. */
      function holdIsLive() {
        return resource.data.get('firstLookUntil', 0) is number
               && request.time.toMillis() < resource.data.get('firstLookUntil', 0);
      }
```

---

## Edit 3 — `fin_projects`: READ

Add one clause. Everything else stays as it is.

```
      allow read: if !blocked()
                  && (isOwner()
                  || isOrgMate()
                  || isAdmin()
                  || isFinAdmin()
                  || (isPartner() && isBrowsable())
                  || isFirstLook()                        /* ← ADD THIS LINE */
                  || (isPartner() && isAwardee()));
```

---

## Edit 4 — `fin_projects`: CREATE

**This is the one that stops the feature working at all.** Your whitelist
refuses `'review'`, so every gated standalone-BESS submission is rejected.

```
      allow create: if !blocked()
                    && (isSubmitter() || isAdmin())
                    && request.resource.data.developerUid == request.auth.uid
                    && request.resource.data.status in ['open', 'draft', 'review']   /* ← 'review' ADDED */
                    && request.resource.data.awardedTo == null
                    && request.resource.data.get('firstLookUids', []).size() == 0    /* ← ADD: never pre-held */
                    && (!('orgKey' in request.resource.data)
                        || request.resource.data.orgKey == myOrgKey());
```

`'exclusive'` is deliberately **not** in the list — a hold is something the
operator applies on update, never something a sponsor can file into.

---

## Edit 5 — `fin_projects`: UPDATE

Your current rule is `isOwner() || isAdmin()`. Three changes:

```
      /* Owners may correct their own deals. A sponsor may NOT put their own
         deal on a first-look hold — only the operator does that — so the hold
         fields are pinned on their writes. The one exception is clearing a
         hold whose window has already run out, which is how an expired
         exclusive gets released without waiting for an administrator. */
      allow update: if !blocked()
                    && isOwner()
                    && request.resource.data.developerUid == resource.data.developerUid
                    && request.resource.data.get('firstLookUids', [])
                       == resource.data.get('firstLookUids', [])
                    && (
                         request.resource.data.get('firstLookUntil', 0)
                           == resource.data.get('firstLookUntil', 0)
                         || (resource.data.status == 'exclusive'
                             && !holdIsLive()
                             && request.resource.data.status == 'open')
                       );

      /* The marketplace operator: approves out of the review queue, holds,
         releases, and sends back. isFinAdmin() is ADDED alongside isAdmin()
         because the console runs these as role=='admin' OR ClearSky domain —
         without it, a role-admin on any other domain cannot approve anything.
         It still cannot award: awardedTo is pinned. */
      allow update: if !blocked()
                    && (isAdmin() || isFinAdmin())
                    && request.resource.data.developerUid == resource.data.developerUid
                    && request.resource.data.get('awardedTo', null)
                       == resource.data.get('awardedTo', null);

      /* The first-look partner passing: releases the deal to the marketplace.
         hasOnly() pins every other field, so this cannot reach the numbers,
         the owner or the award. Allowed after the window closes too — a late
         pass is still a pass, and it saves waiting for a sweep. */
      allow update: if !blocked()
                    && isFirstLook()
                    && resource.data.status == 'exclusive'
                    && request.resource.data.diff(resource.data).affectedKeys()
                         .hasOnly(['status', 'firstLookUids', 'firstLookPastUids',
                                   'firstLookDecision', 'firstLookDecidedAt',
                                   'firstLookDecidedBy', 'firstLookUntil'])
                    && request.resource.data.status == 'open'
                    && request.resource.data.get('firstLookUids', []).size() == 0;

      /* Taking the first look only stamps the decision — the deal stays
         exclusive while terms are worked out. Live window only. */
      allow update: if !blocked()
                    && isFirstLook()
                    && resource.data.status == 'exclusive'
                    && holdIsLive()
                    && request.resource.data.diff(resource.data).affectedKeys()
                         .hasOnly(['firstLookDecision', 'firstLookDecidedAt', 'firstLookDecidedBy'])
                    && request.resource.data.firstLookDecision == 'accepted';
```

Multiple `allow update` statements are OR'd, so keeping them separate is
correct and keeps each one readable.

---

## Edit 6 — `offers`: the unlock gate vs. the first look

**This is the subtle one.** Your live rule requires a firm to have unlocked a
deal before it can offer:

```
        allow create: if isPartner()
                    && ...
                    && hasUnlocked(projectId);                 /* ← UNLOCK GATE */
```

The portal now exempts a held deal from the token meter — the hold *is* the
invitation, and a partner out of tokens who cannot open their own exclusive
would let the window lapse unread. But the rule still demands an unlock
record, so **Amperage takes the first look, presses "Make an offer", and the
database refuses it.**

Two ways out. Pick one:

**(a) Let the first-look holder offer without spending a token** — matches the
portal as built:

```
        allow create: if isPartner()
                    && offerId == request.auth.uid
                    && request.resource.data.partnerUid == request.auth.uid
                    && parent().status != 'awarded'
                    && (
                         hasUnlocked(projectId)                        /* UNLOCK GATE */
                         || (parent().status == 'exclusive'            /* ← first-look exemption */
                             && request.auth.uid in parent().get('firstLookUids', [])
                             && request.time.toMillis() < parent().get('firstLookUntil', 0))
                       );
```

**(b) Keep the gate absolute** — a held deal costs a token like any other. Then
change the portal too: remove the exemption clause in `needsToken()` in
`index.html`, or Amperage will see an unlocked file and still be refused when
they offer.

I would take (a). Charging a token for a deal you handed someone exclusively
reads as a toll on a favour, and (b)'s failure mode is a partner who cannot act
on their own exclusive because their monthly allowance ran out.

Whichever you choose, **the rule and `needsToken()` must agree.** A UI that
offers a button the database refuses is worse than either policy.

---

## Edit 7 — view tracking: two new blocks

### 7a. Nested, inside `match /fin_projects/{projectId}`

```
      /* One document per capital FIRM per deal: an open count and the
         strongest signal they have given. The document id IS the writer's
         organisation key, so a firm can only ever write its own record —
         there is no path on which one partner writes or inflates another's. */
      match /fin_views/{orgKey} {
        function parent() {
          return get(/databases/$(database)/documents/fin_projects/$(projectId)).data;
        }
        function isMyFirm() {
          return isPartner() && !finBlocked() && finOrgKey() != '' && orgKey == finOrgKey();
        }
        /* A partner reads only their OWN firm's record, never a rival's —
           who else is circling is exactly what this collection contains. */
        allow read: if isAdmin()
                    || (hasFinProfile() && isFinAdmin())
                    || parent().developerUid == request.auth.uid
                    || (finOrgKey() != '' && parent().get('orgKey', '\u0000') == finOrgKey())
                    || isMyFirm();
        /* Only against a deal the partner can actually see, so a record
           cannot be manufactured for one in the review queue or held for
           somebody else. sponsorOrgKey is checked against the parent rather
           than trusted, because the sponsor's own query filters on it. */
        allow create, update: if isMyFirm()
                    && request.resource.data.orgKey == orgKey
                    && request.resource.data.sponsorOrgKey == parent().get('orgKey', '')
                    && (
                         parent().status == 'open'
                         || parent().get('awardedTo', '') == request.auth.uid
                         || request.auth.uid in parent().get('firstLookUids', [])
                       );
        allow delete: if isAdmin() || (hasFinProfile() && isFinAdmin());
      }
```

### 7b. Top level — the collection-group read

A collection-group query is **not** authorised by the nested rule. The
sponsor's cross-book query needs a rule matched at the group path:

```
    /* Sponsors read engagement across their whole book in one query:
         collectionGroup('fin_views').where('sponsorOrgKey','==', myOrgKey())
       Named fin_views, not views, because this wildcard reaches across the
       whole shared database and a bare "views" would match every other
       portal's data. Empty org keys excluded on both sides so a profile
       without orgKey does not match every record without one. */
    match /{path=**}/fin_views/{orgKey} {
      allow read: if isAdmin()
                  || (hasFinProfile() && isFinAdmin())
                  || (finOrgKey() != ''
                      && resource.data.get('sponsorOrgKey', '\u0000') == finOrgKey())
                  || (isPartner() && finOrgKey() != '' && orgKey == finOrgKey());
      allow write: if false;
    }
```

---

## Worth knowing: you already have half of this

`fin_orgs/{orgKey}/unlocks/{dealId}` already lets a sponsor read the unlocks
against their own deals:

```
        || (hasFinProfile() && finOrgKey() != ''
            && resource.data.get('sponsorOrgKey', '') == finOrgKey());
```

So *"which firms unlocked my deal"* was already answerable. `fin_views` adds
the stage before it — **who opened it and did not unlock**, which is the more
useful number, because a deal nobody opens is a positioning problem and a deal
opened but never unlocked is a pricing one.

The portal reads both: unlocks feed the "unlocked the file" stage of the
funnel via the `unlockedAt` stamp on the view record.

---

## After deploying

1. Firebase Console → Firestore → Rules, and search the **live** text for
   `termsAcceptances`. If it is not there, nobody can sign in anywhere.
2. Search for `fin_views` and `fin_settings` to confirm the new blocks landed.
3. File a test standalone BESS deal as a sponsor. It should appear in the
   admin Review tab and nowhere on the capital side.
4. Hold it for Amperage, sign in as an Amperage partner, and press **Make an
   offer**. If that is refused, Edit 6 was not applied.

## Still open, and not mine to decide

Your own file flags `isConsoleViewer()` — `sunesol.com` and `ogisolar.com` get
a **cross-org read of every tenant's `/projects`**. If OGI Solar is now a
restricted trial tenant, that hands them FENECON's, Concord's and iQGen's
project data. Unrelated to this work, but it is in the same file you are about
to edit, and your note says it needs a decision before their trial opens.
