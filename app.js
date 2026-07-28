/* ============================================================
   ClearSky-OMEGA · Financing Partners Portal
   app.js — single-file ES5 application logic
   ------------------------------------------------------------
   Constraints (ClearSky house style):
   - ES5 only: no arrow functions, no template literals,
     no let/const, no optional chaining, no async/await.
   - Firebase compat SDK v8 (window.firebase.*).
   ------------------------------------------------------------
   Data model (Firestore):

   users/{uid}
     name, org, email, role ("developer" | "partner"), createdAt

   projects/{projectId}
     name, type, capacityKw, costBasis, proformaSummary,
     location, notes,
     developerUid, developerOrg, developerName,
     status ("open" | "offered" | "awarded"),
     offerCount,
     awardedTo (partner uid | null),
     awardedToOrg (string | null),
     docs: { sitemap:{name,url,path}, cost:{...}, proforma:{...} },
     createdAt, updatedAt

   projects/{projectId}/offers/{offerId}
     partnerUid, partnerOrg, partnerName,
     amount, structure ("debt"|"tax_equity"|"acquisition"|"long_hold"),
     terms, holdYears,
     status ("pending" | "accepted" | "rejected" | "recalled"),
     createdAt

   projects/{projectId}/inquiries/{msgId}
     authorUid, authorName, authorRole, body, createdAt
   ============================================================ */

/* ---------- collection names (namespaced to avoid collision with
   other portals sharing the clearsky-portal Firestore) ---------- */
var COL_PROFILES = "fin_profiles";      // this portal's user profiles
var COL_PROJECTS = "fin_projects";      // this portal's projects
var COL_ALLOWLIST = "partnerAllowlist"; // SHARED existing allowlist (partner + admin)

/* ---------- roles ----------
   developer  - builds projects, submits own deals
   originator - brings deal flow, submits deals, not a builder
   partner    - capital side; underwrites and offers (allowlist-gated)
   admin      - sees every deal, table view, CSV export (allowlist-gated)
   ------------------------------------------------------------------ */
var ROLE_LABELS = {
  developer: "Developer",
  originator: "Originator",
  partner: "Capital partner",
  admin: "Administrator"
};

/* roles that may create a project */
function isSubmitterRole(r) { return r === "developer" || r === "originator"; }
function canSubmit() { return isSubmitterRole(STATE.role); }
function isAdminRole() { return STATE.role === "admin"; }
function isPartnerRole() { return STATE.role === "partner"; }

/* roles a user may pick for themselves at signup (the rest are allowlisted) */
var SELF_ROLES = ["developer", "originator"];
/* roles that may only be granted by an allowlist entry */
var GRANTED_ROLES = ["partner", "admin"];

/* ---------- global state ---------- */
var STATE = {
  user: null,          // firebase user
  profile: null,       // fin_profiles/{uid} doc data
  role: null,          // "developer" | "originator" | "partner" | "admin"
  projects: [],        // loaded project list (role-scoped)
  activeTab: null,     // current filter tab id
  regRole: "developer",// selected role on register form
  unsub: null,         // active Firestore listener unsubscribe
  adminFilters: {      // admin table filter state
    q: "", submitter: "", role: "", status: "", type: ""
  },
  adminSort: { key: "createdAt", dir: -1 }
};

var STRUCTURE_LABELS = {
  debt: "Project debt",
  tax_equity: "Tax equity",
  acquisition: "Acquisition",
  long_hold: "Long-hold ownership"
};

var TYPE_LABELS = {
  bess: "BESS / Storage",
  ev: "EV Charging",
  microgrid: "Microgrid",
  solar_storage: "Solar + Storage",
  compute: "Compute / Data center",
  other: "Other DER"
};

/* ---------- tiny helpers ---------- */
function $(id) { return document.getElementById(id); }

function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) { e.className = cls; }
  if (html !== undefined && html !== null) { e.innerHTML = html; }
  return e;
}

function esc(s) {
  if (s === undefined || s === null) { return ""; }
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Only ever render http(s) links. User-supplied URLs are otherwise an
   easy route to javascript: / data: injection via an anchor href. */
function safeUrl(u) {
  if (!u) { return null; }
  u = String(u).trim();
  if (/^https?:\/\//i.test(u)) { return u; }
  return null;
}

/* pull the hostname out of a URL so a link row can show where it goes */
function linkHost(u) {
  var m = /^https?:\/\/([^\/?#]+)/i.exec(String(u || ""));
  if (!m) { return ""; }
  return m[1].replace(/^www\./i, "");
}

/* label presets offered when adding a shared link */
var LINK_PRESETS = [
  "Utility bills",
  "Site details",
  "Interconnection",
  "Offtake / PPA",
  "Permits",
  "Diligence folder"
];

/* ---------- project accessors ---------- */
var DOC_SLOTS = [
  ["sitemap", "Site map"],
  ["cost", "Cost basis"],
  ["proforma", "Pro forma"]
];

/* normalise p.links into a clean array of {label,url} with safe urls only */
function projectLinks(p) {
  var out = [];
  var raw = (p && p.links) ? p.links : [];
  if (!raw.length) { return out; }
  for (var i = 0; i < raw.length; i++) {
    var u = safeUrl(raw[i] && raw[i].url);
    if (!u) { continue; }
    out.push({ label: (raw[i].label || "Link"), url: u });
  }
  return out;
}

function countLinks(p) { return projectLinks(p).length; }

function countDocs(p) {
  var docs = (p && p.docs) ? p.docs : {};
  var n = 0;
  for (var i = 0; i < DOC_SLOTS.length; i++) {
    var k = DOC_SLOTS[i][0];
    if (docs[k] && docs[k].url) { n++; }
  }
  return n;
}

/* who submitted this deal, for display and admin filtering */
function submitterName(p) { return (p && (p.developerName || p.developerOrg)) || "Unknown"; }
function submitterOrg(p) { return (p && (p.developerOrg || p.developerName)) || "Unknown"; }
function submitterRole(p) { return (p && p.submitterRole) || "developer"; }
function submitterKey(p) { return submitterOrg(p) + " \u00b7 " + submitterName(p); }

function initials(name) {
  if (!name) { return "?"; }
  var parts = name.trim().split(/\s+/);
  if (parts.length === 1) { return parts[0].charAt(0).toUpperCase(); }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function fmtMoney(n) {
  if (n === undefined || n === null || n === "" || isNaN(n)) { return "\u2014"; }
  n = Number(n);
  if (n >= 1000000) { return "$" + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 2) + "M"; }
  if (n >= 1000) { return "$" + (n / 1000).toFixed(0) + "K"; }
  return "$" + n.toLocaleString();
}

function fmtKw(n) {
  if (!n || isNaN(n)) { return "\u2014"; }
  n = Number(n);
  if (n >= 1000) { return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + " MW"; }
  return n + " kW";
}

function fmtDate(ts) {
  if (!ts) { return ""; }
  var d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(ts) {
  if (!ts) { return ""; }
  var d = ts.toDate ? ts.toDate() : new Date(ts);
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) { return "just now"; }
  if (s < 3600) { return Math.floor(s / 60) + "m ago"; }
  if (s < 86400) { return Math.floor(s / 3600) + "h ago"; }
  if (s < 604800) { return Math.floor(s / 86400) + "d ago"; }
  return fmtDate(ts);
}

function toast(msg, isErr) {
  var t = $("toast");
  t.textContent = msg;
  t.className = isErr ? "err show" : "show";
  setTimeout(function () { t.className = t.className.replace("show", "").trim(); }, 2600);
}

function showAuthErr(msg) {
  var e = $("authErr");
  e.textContent = msg;
  e.className = "auth-err show";
}
function clearAuthErr() { $("authErr").className = "auth-err"; }

function friendlyAuthError(err) {
  var c = err && err.code ? err.code : "";
  if (c.indexOf("email-already-in-use") > -1) { return "That email already has an account. Try logging in."; }
  if (c.indexOf("invalid-email") > -1) { return "That doesn't look like a valid email."; }
  if (c.indexOf("weak-password") > -1) { return "Password must be at least 6 characters."; }
  if (c.indexOf("wrong-password") > -1 || c.indexOf("invalid-credential") > -1) { return "Incorrect email or password."; }
  if (c.indexOf("user-not-found") > -1) { return "No account found for that email."; }
  if (c.indexOf("too-many-requests") > -1) { return "Too many attempts. Please wait and try again."; }
  if (c.indexOf("popup-closed") > -1) { return "Sign-in was cancelled."; }
  return (err && err.message) ? err.message : "Something went wrong. Please try again.";
}

/* ============================================================
   AUTH WIRING
   ============================================================ */
function wireAuthUI() {
  /* register / login toggle */
  $("toRegister").onclick = function () {
    clearAuthErr();
    $("loginForm").style.display = "none";
    $("registerForm").style.display = "block";
  };
  $("toLogin").onclick = function () {
    clearAuthErr();
    $("registerForm").style.display = "none";
    $("loginForm").style.display = "block";
  };

  /* role pick */
  $("roleDev").onclick = function () { selectRegRole("developer"); };
  $("roleOrig").onclick = function () { selectRegRole("originator"); };
  $("rolePartner").onclick = function () { selectRegRole("partner"); };

  /* login */
  $("loginBtn").onclick = doLogin;
  $("loginPass").onkeydown = function (e) { if (e.key === "Enter") { doLogin(); } };
  $("googleLoginBtn").onclick = doGoogle;

  /* register */
  $("registerBtn").onclick = doRegister;
  $("regPass").onkeydown = function (e) { if (e.key === "Enter") { doRegister(); } };

  /* deep link ?mode=register */
  if (window.location.search.indexOf("mode=register") > -1) {
    $("loginForm").style.display = "none";
    $("registerForm").style.display = "block";
  }

  /* sign out */
  $("signOutBtn").onclick = function () {
    if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }
    auth.signOut();
  };
}

function selectRegRole(role) {
  STATE.regRole = role;
  $("roleDev").className = "role-opt" + (role === "developer" ? " sel" : "");
  $("roleOrig").className = "role-opt" + (role === "originator" ? " sel" : "");
  $("rolePartner").className = "role-opt" + (role === "partner" ? " sel" : "");

  var hint = $("regRoleHint");
  if (hint) {
    if (role === "originator") {
      hint.textContent = "Originators submit deals they source but don't build. You'll manage offers on everything you bring in.";
    } else if (role === "partner") {
      hint.textContent = "Capital partner access is granted by invitation. Use the email we have on file.";
    } else {
      hint.textContent = "Developers submit projects they're building and take offers on them.";
    }
  }
}

function doLogin() {
  clearAuthErr();
  var email = $("loginEmail").value.trim();
  var pass = $("loginPass").value;
  if (!email || !pass) { showAuthErr("Enter your email and password."); return; }
  $("loginBtn").disabled = true;
  auth.signInWithEmailAndPassword(email, pass)
    .catch(function (err) { showAuthErr(friendlyAuthError(err)); })
    .then(function () { $("loginBtn").disabled = false; });
}

function doRegister() {
  clearAuthErr();
  var name = $("regName").value.trim();
  var org = $("regOrg").value.trim();
  var email = $("regEmail").value.trim();
  var pass = $("regPass").value;
  if (!name || !org || !email || !pass) { showAuthErr("Please fill in every field."); return; }
  if (pass.length < 6) { showAuthErr("Password must be at least 6 characters."); return; }

  $("registerBtn").disabled = true;
  var wantsGranted = (GRANTED_ROLES.indexOf(STATE.regRole) > -1);
  var emailKey = email.toLowerCase();

  /* Elevated roles (partner, admin) are gated by the shared allowlist.
     Developer and originator are self-select. If an email is allowlisted,
     the allowlist role always wins over whatever they picked. */
  db.collection(COL_ALLOWLIST).doc(emailKey).get()
    .then(function (snap) {
      var allowData = snap.exists ? snap.data() : null;
      var grantedRole = null;
      if (allowData && allowData.active === true
          && GRANTED_ROLES.indexOf(allowData.role) > -1) {
        grantedRole = allowData.role;
      }
      var allowed = !!grantedRole;

      if (wantsGranted && grantedRole !== STATE.regRole) {
        throw { code: "app/not-allowlisted" };
      }

      var role = grantedRole || STATE.regRole;
      if (SELF_ROLES.indexOf(role) === -1 && GRANTED_ROLES.indexOf(role) === -1) {
        role = "developer";
      }
      /* let an allowlisted account keep the org name we already have on file */
      var finalOrg = org;
      if (allowed && allowData && allowData["partner account"]) {
        finalOrg = allowData["partner account"];
      }

      return auth.createUserWithEmailAndPassword(email, pass).then(function (cred) {
        return db.collection(COL_PROFILES).doc(cred.user.uid).set({
          name: name, org: finalOrg, email: email, emailLower: emailKey, role: role,
          allowlisted: allowed,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    })
    .catch(function (err) {
      if (err && err.code === "app/not-allowlisted") {
        showAuthErr("That email isn't on the allowlist for " +
          (ROLE_LABELS[STATE.regRole] || "that role").toLowerCase() +
          " access yet. Register as a developer or originator, or contact info@csebuilders.com to be added.");
      } else {
        showAuthErr(friendlyAuthError(err));
      }
    })
    .then(function () { $("registerBtn").disabled = false; });
}

function doGoogle() {
  clearAuthErr();
  var provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider)
    .then(function (result) {
      var u = result.user;
      var ref = db.collection(COL_PROFILES).doc(u.uid);
      return ref.get().then(function (snap) {
        if (snap.exists) { return null; }
        /* new Google user: gate partner role by the shared allowlist,
           same as email/password signup. */
        var emailKey = (u.email || "").toLowerCase();
        return db.collection(COL_ALLOWLIST).doc(emailKey).get().then(function (al) {
          var alData = al.exists ? al.data() : null;
          var grantedRole = null;
          if (alData && alData.active === true
              && GRANTED_ROLES.indexOf(alData.role) > -1) {
            grantedRole = alData.role;
          }
          var allowed = !!grantedRole;
          /* fall back to whatever they picked on the form, else developer */
          var picked = SELF_ROLES.indexOf(STATE.regRole) > -1 ? STATE.regRole : "developer";
          var role = grantedRole || picked;
          var domain = (u.email || "").split("@")[1] || "";
          var org = domain;
          if (allowed && alData["partner account"]) { org = alData["partner account"]; }
          return ref.set({
            name: u.displayName || u.email,
            org: org,
            email: u.email,
            emailLower: emailKey,
            role: role,
            allowlisted: allowed,
            createdAt: FieldValue.serverTimestamp()
          });
        });
      });
    })
    .catch(function (err) { showAuthErr(friendlyAuthError(err)); });
}

/* ============================================================
   AUTH STATE OBSERVER
   ============================================================ */
function onAuth(user) {
  if (!user) {
    STATE.user = null; STATE.profile = null; STATE.role = null;
    $("appView").style.display = "none";
    $("authView").style.display = "flex";
    return;
  }
  STATE.user = user;
  /* load profile */
  db.collection(COL_PROFILES).doc(user.uid).get().then(function (snap) {
    if (!snap.exists) {
      /* profile not created yet (race) — retry shortly */
      setTimeout(function () { onAuth(auth.currentUser); }, 600);
      return;
    }
    STATE.profile = snap.data();
    STATE.role = STATE.profile.role || "developer";
    enterApp();
  }).catch(function (err) {
    toast(friendlyAuthError(err), true);
  });
}

function enterApp() {
  $("authView").style.display = "none";
  $("appView").style.display = "block";

  /* header */
  $("userName").textContent = STATE.profile.name || STATE.profile.email;
  $("userAvatar").textContent = initials(STATE.profile.name || STATE.profile.email);
  var chip = $("roleChip");
  chip.textContent = ROLE_LABELS[STATE.role] || STATE.role;

  if (STATE.role === "developer") {
    chip.className = "role-chip dev";
    $("pageTitle").textContent = "My projects";
    $("pageSub").textContent = "Submit projects and manage the offers on them.";
    $("newProjectBtn").style.display = "inline-flex";
    $("newProjectBtn").lastChild.nodeValue = " Submit a project";
  } else if (STATE.role === "originator") {
    chip.className = "role-chip orig";
    $("pageTitle").textContent = "My deals";
    $("pageSub").textContent = "Submit the deals you source and manage the offers that come in.";
    $("newProjectBtn").style.display = "inline-flex";
    $("newProjectBtn").lastChild.nodeValue = " Submit a deal";
  } else if (STATE.role === "admin") {
    chip.className = "role-chip admin";
    $("pageTitle").textContent = "All deals";
    $("pageSub").textContent = "Every submission across the marketplace. Filter, open, and export.";
    $("newProjectBtn").style.display = "none";
  } else {
    chip.className = "role-chip partner";
    $("pageTitle").textContent = "Open pipeline";
    $("pageSub").textContent = "Underwrite open deals, then offer, decline, or inquire.";
    $("newProjectBtn").style.display = "none";
  }

  $("newProjectBtn").onclick = openSubmitModal;

  /* fresh view state for this session — a previous user's filters and the
     old admin sheet must not survive a sign-out / sign-in on the same tab */
  STATE.adminFilters = { q: "", submitter: "", role: "", status: "", type: "" };
  STATE.adminSort = { key: "createdAt", dir: -1 };
  $("listArea").innerHTML = '<div class="loading"><div class="spinner"></div></div>';

  buildTabs();
  subscribeProjects();
}

/* ============================================================
   TABS + PROJECT SUBSCRIPTION
   ============================================================ */
function buildTabs() {
  var tabs = $("tabs");
  tabs.innerHTML = "";
  var defs;
  if (isAdminRole()) {
    defs = [
      { id: "all", label: "All deals" },
      { id: "open", label: "Open" },
      { id: "offered", label: "Closed" },
      { id: "awarded", label: "Awarded" }
    ];
  } else if (canSubmit()) {
    defs = [
      { id: "all", label: STATE.role === "originator" ? "All deals" : "All projects" },
      { id: "open", label: "Open" },
      { id: "offered", label: "Closed" },
      { id: "awarded", label: "Awarded" }
    ];
  } else {
    defs = [
      { id: "open", label: "Open to underwrite" },
      { id: "mine", label: "My offers" },
      { id: "won", label: "Awarded to me" }
    ];
  }
  if (!STATE.activeTab) { STATE.activeTab = defs[0].id; }
  for (var i = 0; i < defs.length; i++) {
    (function (d) {
      var b = el("button", "tab" + (STATE.activeTab === d.id ? " active" : ""), esc(d.label));
      var cnt = el("span", "cnt", "0"); cnt.id = "cnt-" + d.id;
      b.appendChild(cnt);
      b.onclick = function () {
        STATE.activeTab = d.id;
        var all = tabs.querySelectorAll(".tab");
        for (var j = 0; j < all.length; j++) { all[j].className = "tab"; }
        b.className = "tab active";
        renderList();
      };
      tabs.appendChild(b);
    })(defs[i]);
  }
}

function enrichPartnerOffers(list) {
  /* For a partner, read THEIR own offer (offers/{uid}) on each project so we
     can label cards Pending/Rejected/Accepted. Reads only our own offer doc,
     which the rules allow. Missing offer => _myOfferStatus stays null. */
  var uid = STATE.user.uid;
  var reads = [];
  for (var i = 0; i < list.length; i++) {
    (function (proj) {
      var r = db.collection(COL_PROJECTS).doc(proj._id)
        .collection("offers").doc(uid).get()
        .then(function (d) {
          proj._myOfferStatus = (d.exists && d.data()) ? d.data().status : null;
          proj._hasMyOffer = !!proj._myOfferStatus;
        })["catch"](function () {
          proj._myOfferStatus = null; proj._hasMyOffer = false;
        });
      reads.push(r);
    })(list[i]);
  }
  return Promise.all(reads);
}

function subscribeProjects() {
  if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }

  var q;
  if (isAdminRole()) {
    /* admin sees the whole marketplace, unfiltered */
    q = db.collection(COL_PROJECTS);
  } else if (canSubmit()) {
    /* developers and originators see ONLY the deals they submitted */
    q = db.collection(COL_PROJECTS).where("developerUid", "==", STATE.user.uid);
  } else {
    /* partners browse OPEN projects (project stays open even with offers in;
       each partner's own offer carries the pending/rejected/accepted state).
       Awarded-to-me projects are merged in separately below. */
    q = db.collection(COL_PROJECTS).where("status", "==", "open");
  }

  STATE.unsub = q.onSnapshot(function (snap) {
    var list = [];
    snap.forEach(function (doc) {
      var d = doc.data(); d._id = doc.id; list.push(d);
    });

    if (isPartnerRole()) {
      /* merge in deals awarded to this partner */
      db.collection(COL_PROJECTS).where("awardedTo", "==", STATE.user.uid).get()
        .then(function (wonSnap) {
          wonSnap.forEach(function (doc) {
            var d = doc.data(); d._id = doc.id;
            var dup = false;
            for (var k = 0; k < list.length; k++) { if (list[k]._id === d._id) { dup = true; break; } }
            if (!dup) { list.push(d); }
          });
          /* enrich each project with THIS partner's own offer status (if any),
             so cards/tabs can show Pending / Rejected without reading others'
             offers. One direct doc read per project (id == our uid). */
          enrichPartnerOffers(list).then(function () {
            STATE.projects = list;
            renderList();
          });
        })
        .catch(function () { STATE.projects = list; renderList(); });
    } else {
      STATE.projects = list;
      renderList();
    }
  }, function (err) {
    $("listArea").innerHTML = "";
    var e = el("div", "empty");
    e.innerHTML = '<h3>Could not load projects</h3><p>' + esc(friendlyAuthError(err)) +
      '</p><p style="font-size:12px;color:var(--cs-muted-2)">If this is a permissions error, check your Firestore rules are deployed.</p>';
    $("listArea").appendChild(e);
  });
}

/* filter the loaded projects for the active tab */
function filteredProjects() {
  var p = STATE.projects.slice();
  var uid = STATE.user.uid;
  var t = STATE.activeTab;

  if (canSubmit() || isAdminRole()) {
    if (t === "open") { return p.filter(function (x) { return x.status === "open"; }); }
    if (t === "offered") { return p.filter(function (x) { return x.status === "closed"; }); }
    if (t === "awarded") { return p.filter(function (x) { return x.status === "awarded"; }); }
    return p; /* all */
  } else {
    if (t === "won") { return p.filter(function (x) { return x.awardedTo === uid; }); }
    if (t === "mine") {
      /* projects where this partner has an active offer (reliably set by
         enrichPartnerOffers on load). */
      return p.filter(function (x) { return x._hasMyOffer; });
    }
    /* open pipeline: browsable open projects (closed/awarded excluded) */
    return p.filter(function (x) { return x.status === "open"; });
  }
}

function updateTabCounts() {
  var p = STATE.projects; var uid = STATE.user.uid;
  function setc(id, n) { var e = $("cnt-" + id); if (e) { e.textContent = n; } }
  if (canSubmit() || isAdminRole()) {
    setc("all", p.length);
    setc("open", p.filter(function (x) { return x.status === "open"; }).length);
    setc("offered", p.filter(function (x) { return x.status === "closed"; }).length);
    setc("awarded", p.filter(function (x) { return x.status === "awarded"; }).length);
  } else {
    setc("open", p.filter(function (x) { return x.status === "open"; }).length);
    setc("mine", p.filter(function (x) { return x._hasMyOffer; }).length);
    setc("won", p.filter(function (x) { return x.awardedTo === uid; }).length);
  }
}

/* ============================================================
   RENDER LIST
   ============================================================ */
function renderList() {
  updateTabCounts();
  var area = $("listArea");

  /* Admins get the spreadsheet view. It manages its own DOM so that a live
     snapshot update refreshes the rows without stealing focus from the
     filter box mid-keystroke. */
  if (isAdminRole()) { renderAdminTable(area); return; }

  area.innerHTML = "";
  var items = filteredProjects();

  /* sort: newest first */
  items.sort(function (a, b) {
    var ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    var tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    return tb - ta;
  });

  if (items.length === 0) { area.appendChild(emptyState()); return; }

  var grid = el("div", "proj-grid");
  for (var i = 0; i < items.length; i++) {
    grid.appendChild(projectCard(items[i]));
  }
  area.appendChild(grid);
}

function emptyState() {
  var e = el("div", "empty");
  var icon = '<div class="e-ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg></div>';
  if (canSubmit()) {
    var noun = (STATE.role === "originator") ? "deal" : "project";
    if (STATE.activeTab === "all") {
      e.innerHTML = icon + '<h3>No ' + noun + 's yet</h3><p>Submit your first ' + noun +
        ' \u2014 the numbers, any documents, and links to your utility bills and site details \u2014 and capital partners can start underwriting it.</p>';
      var b = el("button", "btn btn-primary", "Submit a " + noun);
      b.onclick = openSubmitModal; e.appendChild(b);
    } else {
      e.innerHTML = icon + '<h3>Nothing here</h3><p>No ' + noun + 's match this filter yet.</p>';
    }
  } else {
    if (STATE.activeTab === "won") {
      e.innerHTML = icon + '<h3>No awarded deals yet</h3><p>Projects you win will appear here. Make an offer on an open project to get started.</p>';
    } else if (STATE.activeTab === "mine") {
      e.innerHTML = icon + '<h3>No offers yet</h3><p>Open a project from the pipeline and make an offer \u2014 it will show up here.</p>';
    } else {
      e.innerHTML = icon + '<h3>Pipeline is clear</h3><p>There are no open projects to underwrite right now. Check back \u2014 new submissions post here in real time.</p>';
    }
  }
  return e;
}

function projectCard(p) {
  var locked = (isPartnerRole() && p.status === "awarded" && p.awardedTo !== STATE.user.uid);
  var card = el("div", "proj-card" + (locked ? " locked" : ""));

  var statusCls, statusTxt;
  if (isPartnerRole()) {
    /* Partner sees the status of THEIR OWN offer, not the project's global
       state. The project stays 'open' to everyone; each partner's card
       reflects their own bid. */
    if (p.status === "awarded" && p.awardedTo === STATE.user.uid) {
      statusCls = "st-awarded"; statusTxt = "Awarded to you";
    } else if (p.status === "awarded") {
      statusCls = "st-locked"; statusTxt = "Awarded \u00b7 sealed";
    } else if (p._myOfferStatus === "pending") {
      statusCls = "st-offered"; statusTxt = "Pending";
    } else if (p._myOfferStatus === "rejected") {
      statusCls = "st-withdrawn"; statusTxt = "Rejected";
    } else if (p._myOfferStatus === "recalled") {
      statusCls = "st-locked"; statusTxt = "Recalled";
    } else {
      statusCls = "st-open"; statusTxt = "Open";
    }
  } else {
    /* developer view: project-level status */
    if (p.status === "open") { statusCls = "st-open"; statusTxt = "Open"; }
    else if (p.status === "closed") { statusCls = "st-locked"; statusTxt = "Closed"; }
    else if (p.status === "awarded") { statusCls = "st-awarded"; statusTxt = "Awarded"; }
    else { statusCls = "st-locked"; statusTxt = esc(p.status); }
  }

  var top = el("div", "pc-top");
  var left = el("div");
  left.innerHTML = '<div class="pc-name">' + esc(p.name || "Untitled project") + '</div>' +
    '<div class="pc-meta">' + esc(TYPE_LABELS[p.type] || p.type || "Project") +
    (p.location ? " \u00b7 " + esc(p.location) : "") + '</div>';
  top.appendChild(left);
  top.appendChild(el("span", "status-pill " + statusCls, statusTxt));
  card.appendChild(top);

  if (locked) {
    /* sealed card: name + type only, no numbers, no click */
    var seal = el("div");
    seal.style.cssText = "font-size:12.5px;color:var(--cs-muted);margin-top:6px;line-height:1.5;";
    seal.innerHTML = "This project has been awarded to another partner. Its documents and terms are sealed.";
    card.appendChild(seal);
    return card;
  }

  /* stats */
  var stats = el("div", "pc-stats");
  stats.innerHTML =
    '<div class="pc-stat"><div class="k">Capacity</div><div class="v">' + fmtKw(p.capacityKw) + '</div></div>' +
    '<div class="pc-stat"><div class="k">Cost basis</div><div class="v">' + fmtMoney(p.costBasis) + '</div></div>';
  card.appendChild(stats);

  if (p.proformaSummary) {
    var pf = el("div");
    pf.style.cssText = "font-size:12.5px;color:var(--cs-muted);line-height:1.5;margin-bottom:2px;";
    pf.textContent = p.proformaSummary;
    card.appendChild(pf);
  }

  /* attachment summary — how complete is this package? */
  var nDocs = countDocs(p), nLinks = countLinks(p);
  if (nDocs || nLinks) {
    var tags = el("div", "pc-tags");
    if (nDocs) { tags.appendChild(el("span", "pc-tag", nDocs + " file" + (nDocs === 1 ? "" : "s"))); }
    if (nLinks) { tags.appendChild(el("span", "pc-tag", nLinks + " link" + (nLinks === 1 ? "" : "s"))); }
    card.appendChild(tags);
  }

  /* foot */
  var foot = el("div", "pc-foot");
  var offers = el("div", "pc-offers");
  if (canSubmit()) {
    var n = p.offerCount || 0;
    offers.innerHTML = "<b>" + n + "</b> offer" + (n === 1 ? "" : "s");
  } else if (p.awardedTo === STATE.user.uid) {
    offers.innerHTML = "You won this deal";
  } else {
    offers.innerHTML = "Submitted " + esc(fmtDate(p.createdAt));
  }
  foot.appendChild(offers);

  var open = el("button", "btn btn-ghost btn-sm", "View");
  foot.appendChild(open);
  card.appendChild(foot);

  card.onclick = function () { openDetail(p._id); };
  return card;
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */
function openModal(node, wide) {
  var m = $("modalEl");
  m.className = "modal" + (wide ? " wide" : "");
  m.innerHTML = "";
  m.appendChild(node);
  $("modalBackdrop").className = "modal-backdrop show";
}
function closeModal() { $("modalBackdrop").className = "modal-backdrop"; }
$("modalBackdrop").onclick = function (e) { if (e.target === $("modalBackdrop")) { closeModal(); } };

/* pending upload file refs for the submit form */
var PENDING_FILES = { sitemap: null, cost: null, proforma: null };

/* ============================================================
   CLOUD LINKS — shared editor used by the submit form and the
   "edit links" modal. Rows live in the DOM and are scraped on save,
   so there is no parallel state to keep in sync.
   ============================================================ */
function linksField(existing, label, hint) {
  var f = el("div", "field");
  f.innerHTML = '<label>' + esc(label || "Shared links") + '</label>' +
    '<div class="field-note" style="margin-top:0;margin-bottom:9px;">' +
    esc(hint || "Paste a share link to a cloud folder or file \u2014 Drive, Dropbox, SharePoint, Box. Make sure the link is viewable by anyone who has it, or partners will hit a permission wall.") +
    '</div>';

  var rows = el("div"); rows.id = "linkRows";
  f.appendChild(rows);

  var add = el("button", "btn btn-ghost btn-sm", "+ Add a link");
  add.type = "button";
  add.style.marginTop = "4px";
  add.onclick = function () { addLinkRow(rows, "", ""); };
  f.appendChild(add);

  /* seed rows: existing links, or two prompts for the usual suspects */
  var seed = existing && existing.length ? existing : [
    { label: "Utility bills", url: "" },
    { label: "Site details", url: "" }
  ];
  setTimeout(function () {
    for (var i = 0; i < seed.length; i++) {
      addLinkRow(rows, seed[i].label, seed[i].url);
    }
  }, 0);

  return f;
}

function addLinkRow(rows, label, url) {
  var row = el("div", "link-row");

  var lab = document.createElement("input");
  lab.type = "text";
  lab.className = "lr-label";
  lab.setAttribute("list", "linkPresets");
  lab.placeholder = "What is it?";
  lab.value = label || "";

  var u = document.createElement("input");
  u.type = "url";
  u.className = "lr-url";
  u.placeholder = "https://\u2026";
  u.value = url || "";

  var x = el("button", "lr-x", "&times;");
  x.type = "button";
  x.title = "Remove this link";
  x.onclick = function () { rows.removeChild(row); };

  row.appendChild(lab); row.appendChild(u); row.appendChild(x);
  rows.appendChild(row);
  return row;
}

/* scrape the rows; returns {links:[], bad:[]} */
function readLinkRows() {
  var rows = $("linkRows");
  var out = { links: [], bad: [] };
  if (!rows) { return out; }
  var nodes = rows.querySelectorAll(".link-row");
  for (var i = 0; i < nodes.length; i++) {
    var lab = nodes[i].querySelector(".lr-label").value.trim();
    var raw = nodes[i].querySelector(".lr-url").value.trim();
    if (!raw) { continue; }                 /* blank row: skip silently */
    var u = safeUrl(raw);
    if (!u) { out.bad.push(raw); continue; }
    out.links.push({ label: lab || "Link", url: u });
  }
  return out;
}

/* ============================================================
   SUBMIT PROJECT (developer)
   ============================================================ */
function openSubmitModal() {
  PENDING_FILES = { sitemap: null, cost: null, proforma: null };
  var isOrig = (STATE.role === "originator");
  var wrap = el("div");

  wrap.appendChild(modalHead(
    isOrig ? "Submit a deal" : "Submit a project",
    isOrig
      ? "Give partners the numbers and a way into your files. Upload what you have, link the rest."
      : "Attach the site map, cost basis, and pro forma. This becomes the package capital partners underwrite."));

  var body = el("div", "modal-body");
  body.innerHTML =
    '<div class="field"><label>Project name</label><input type="text" id="f-name" placeholder="e.g. Riverside BESS \u2014 Clinton, IA"></div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Project type</label><select id="f-type">' +
        '<option value="bess">BESS / Storage</option>' +
        '<option value="solar_storage">Solar + Storage</option>' +
        '<option value="microgrid">Microgrid</option>' +
        '<option value="ev">EV Charging</option>' +
        '<option value="compute">Compute / Data center</option>' +
        '<option value="other">Other DER</option>' +
      '</select></div>' +
      '<div class="field"><label>Location</label><input type="text" id="f-loc" placeholder="City, State"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Capacity (kW)</label><input type="number" id="f-cap" placeholder="e.g. 2000" min="0"></div>' +
      '<div class="field"><label>Total cost basis (USD)</label><input type="number" id="f-cost" placeholder="e.g. 3200000" min="0"></div>' +
    '</div>' +
    '<div class="field"><label>Pro forma summary</label><textarea id="f-pf" placeholder="Headline returns \u2014 e.g. 14.2% unlevered IRR, 8-yr payback, $410K/yr stacked revenue (arbitrage + capacity + SDVPP)."></textarea></div>' +
    '<div class="field"><label>Notes for partners (optional)</label><textarea id="f-notes" placeholder="Interconnection status, offtake, timeline, incentives, what you\'re looking for (finance vs. acquire)\u2026"></textarea></div>';

  /* ---- cloud links: the fast path, and the one everyone can use ---- */
  body.appendChild(el("div", "form-rule"));
  body.appendChild(linksField(null, "Utility bills, site details, and anything else",
    "Paste a share link to a cloud folder or file \u2014 Drive, Dropbox, SharePoint, Box. Set it to \u201canyone with the link can view\u201d or partners will hit a permission wall."));

  /* ---- direct uploads: optional, collapsed by default ---- */
  body.appendChild(el("div", "form-rule"));
  var upToggle = el("button", "disclosure", "Or upload files directly \u2014 site map, cost basis, pro forma");
  upToggle.type = "button";
  var upBox = el("div", "disclosure-body");
  upBox.style.display = "none";
  upBox.appendChild(fileDropField("sitemap", "Site map", "PDF, PNG, or exported from the SiteMap Designer"));
  upBox.appendChild(fileDropField("cost", "Cost basis", "Cost stack workbook or PDF"));
  upBox.appendChild(fileDropField("proforma", "Pro forma", "Pro forma model (XLSX) or PDF"));
  upToggle.onclick = function () {
    var open = (upBox.style.display !== "none");
    upBox.style.display = open ? "none" : "block";
    upToggle.className = "disclosure" + (open ? "" : " open");
  };
  body.appendChild(upToggle);
  body.appendChild(upBox);

  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var submit = el("button", "btn btn-primary", isOrig ? "Submit deal" : "Submit project");
  submit.id = "submitProjBtn";
  submit.onclick = doSubmitProject;
  foot.appendChild(cancel); foot.appendChild(submit);
  wrap.appendChild(foot);

  openModal(wrap);
}

function modalHead(title, sub) {
  var h = el("div", "modal-head");
  var left = el("div");
  left.innerHTML = '<h2>' + esc(title) + '</h2>' + (sub ? '<div class="mh-sub">' + esc(sub) + '</div>' : "");
  var x = el("button", "modal-close", "&times;"); x.onclick = closeModal;
  h.appendChild(left); h.appendChild(x);
  return h;
}

function fileDropField(key, label, hint) {
  var f = el("div", "field");
  f.innerHTML = '<label>' + esc(label) + '</label>';
  var drop = el("div", "file-drop");
  drop.id = "drop-" + key;
  drop.innerHTML =
    '<label for="file-' + key + '">' +
      '<div class="fd-ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
      '<div class="fd-main">Click to upload ' + esc(label.toLowerCase()) + '</div>' +
      '<div class="fd-sub">' + esc(hint) + '</div>' +
    '</label>' +
    '<input type="file" id="file-' + key + '" style="display:none;">';
  f.appendChild(drop);
  var chipHolder = el("div"); chipHolder.id = "chip-" + key;
  f.appendChild(chipHolder);

  /* wire after insert via setTimeout so element exists */
  setTimeout(function () {
    var input = $("file-" + key);
    if (!input) { return; }
    input.onchange = function () {
      if (input.files && input.files[0]) {
        PENDING_FILES[key] = input.files[0];
        renderFileChip(key, input.files[0].name);
      }
    };
  }, 0);
  return f;
}

function renderFileChip(key, name) {
  var holder = $("chip-" + key);
  var drop = $("drop-" + key);
  if (drop) { drop.style.display = "none"; }
  holder.innerHTML = "";
  var chip = el("div", "file-chip");
  chip.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cs-blue)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
    '<span class="fc-name">' + esc(name) + '</span>';
  var x = el("button", "fc-x", "&times;");
  x.onclick = function () {
    PENDING_FILES[key] = null;
    holder.innerHTML = "";
    if (drop) { drop.style.display = "block"; }
    var input = $("file-" + key); if (input) { input.value = ""; }
  };
  chip.appendChild(x);
  holder.appendChild(chip);
}

function doSubmitProject() {
  var name = $("f-name").value.trim();
  var type = $("f-type").value;
  var loc = $("f-loc").value.trim();
  var cap = $("f-cap").value;
  var cost = $("f-cost").value;
  var pf = $("f-pf").value.trim();
  var notes = $("f-notes").value.trim();

  var noun = (STATE.role === "originator") ? "deal" : "project";
  if (!name) { toast("Give the " + noun + " a name.", true); return; }
  if (!pf) { toast("Add a short pro forma summary.", true); return; }

  var linkRead = readLinkRows();
  if (linkRead.bad.length) {
    toast("Links need to start with http:// or https:// \u2014 check " + linkRead.bad[0], true);
    return;
  }

  var btn = $("submitProjBtn");
  var origLabel = btn.textContent;
  btn.disabled = true; btn.textContent = "Creating\u2026";

  var proj = {
    name: name, type: type, location: loc,
    capacityKw: cap ? Number(cap) : null,
    costBasis: cost ? Number(cost) : null,
    proformaSummary: pf, notes: notes,
    /* developerUid stays the canonical owner field for every submitter role
       so the security rules and existing indexes keep working unchanged. */
    developerUid: STATE.user.uid,
    developerOrg: STATE.profile.org || "",
    developerName: STATE.profile.name || STATE.profile.email,
    submitterRole: STATE.role,
    submitterEmail: STATE.profile.email || "",
    status: "open",
    offerCount: 0,
    awardedTo: null,
    awardedToOrg: null,
    docs: {},
    links: linkRead.links,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  db.collection(COL_PROJECTS).add(proj).then(function (ref) {
    var pid = ref.id;
    /* upload any attached files, then patch docs map */
    var keys = ["sitemap", "cost", "proforma"];
    var uploads = [];
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        var file = PENDING_FILES[k];
        if (!file) { return; }
        var path = "fin_projects/" + pid + "/" + k + "_" + Date.now() + "_" + file.name;
        var task = storage.ref(path).put(file).then(function (snap) {
          return snap.ref.getDownloadURL().then(function (url) {
            return { key: k, meta: { name: file.name, url: url, path: path } };
          });
        });
        uploads.push(task);
      })(keys[i]);
    }
    if (uploads.length === 0) {
      finishSubmit(); return;
    }
    Promise.all(uploads).then(function (results) {
      var docs = {};
      for (var j = 0; j < results.length; j++) { docs[results[j].key] = results[j].meta; }
      return db.collection(COL_PROJECTS).doc(pid).update({ docs: docs });
    }).then(finishSubmit).catch(function (err) {
      toast("Project created, but a file failed to upload: " + friendlyAuthError(err), true);
      closeModal();
    });
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = origLabel;
    toast(friendlyAuthError(err), true);
  });

  function finishSubmit() {
    toast(noun === "deal" ? "Deal submitted to the marketplace." : "Project submitted to the pipeline.");
    closeModal();
  }
}

/* ============================================================
   PROJECT DETAIL (both roles)
   ============================================================ */
function openDetail(pid) {
  /* fetch fresh project + offers + inquiries */
  var wrap = el("div");
  wrap.appendChild(modalHead("Loading\u2026", ""));
  var body = el("div", "modal-body");
  body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  wrap.appendChild(body);
  openModal(wrap, true);

  db.collection(COL_PROJECTS).doc(pid).get().then(function (snap) {
    if (!snap.exists) { closeModal(); toast("Project no longer exists.", true); return; }
    var p = snap.data(); p._id = pid;

    /* guard: partner cannot open a deal awarded to someone else */
    if (isPartnerRole() && p.status === "awarded" && p.awardedTo !== STATE.user.uid) {
      renderSealed(p); return;
    }

    /* load offers + inquiries — role-aware, and each independently so a
       permission miss on one does not blank the other.
       - developer (owner): may read ALL offers on their project.
       - partner: rules only allow reading their OWN offer (doc id == uid),
         so query just that single doc, not the whole collection. */
    var offersCol = db.collection(COL_PROJECTS).doc(pid).collection("offers");
    var offersP;
    if (canSubmit() || isAdminRole()) {
      offersP = offersCol.get().then(function (snap) {
        var arr = []; snap.forEach(function (d) { var o = d.data(); o._id = d.id; arr.push(o); });
        return arr;
      });
    } else {
      // partner: read only my own offer document
      offersP = offersCol.doc(STATE.user.uid).get().then(function (d) {
        if (!d.exists) { return []; }
        var o = d.data(); o._id = d.id; return [o];
      });
    }
    offersP = offersP["catch"](function (err) {
      console && console.warn && console.warn("offers load:", err);
      return [];
    });

    var inqP = db.collection(COL_PROJECTS).doc(pid).collection("inquiries")
      .orderBy("createdAt", "asc").get().then(function (snap) {
        var arr = []; snap.forEach(function (d) { var m = d.data(); m._id = d.id; arr.push(m); });
        return arr;
      })["catch"](function (err) {
        console && console.warn && console.warn("inquiries load:", err);
        return [];
      });

    Promise.all([offersP, inqP]).then(function (res) {
      renderDetail(p, res[0], res[1]);
    });
  }).catch(function (err) {
    closeModal(); toast(friendlyAuthError(err), true);
  });
}

function renderSealed(p) {
  var wrap = el("div");
  wrap.appendChild(modalHead(esc(p.name || "Project"), "Awarded"));
  var body = el("div", "modal-body");
  var lb = el("div", "locked-banner");
  lb.innerHTML =
    '<div class="lb-ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
    '<h3>This deal is sealed</h3>' +
    '<p>' + esc(p.name || "The project") + ' has been awarded to another partner. Its site map, cost, pro forma, and offer history are no longer accessible.</p>';
  body.appendChild(lb);
  wrap.appendChild(body);
  var foot = el("div", "modal-foot");
  var c = el("button", "btn btn-ghost", "Close"); c.onclick = closeModal;
  foot.appendChild(c); wrap.appendChild(foot);
  openModal(wrap, false);
}

function renderDetail(p, offers, inqs) {
  var isAdmin = isAdminRole();
  var isPartner = isPartnerRole();
  var isOwner = (p.developerUid === STATE.user.uid);
  /* the deal's own side of the table: whoever submitted it, plus admins */
  var isSeller = (canSubmit() && isOwner);
  var seesAllOffers = isSeller || isAdmin;
  var myOffer = null;
  for (var i = 0; i < offers.length; i++) {
    if (offers[i].partnerUid === STATE.user.uid) { myOffer = offers[i]; }
  }
  var isAwardedToMe = (p.awardedTo === STATE.user.uid);
  var isAwarded = (p.status === "awarded");

  var wrap = el("div");

  /* head with status */
  var head = el("div", "modal-head");
  var hl = el("div");
  var statusTxt = p.status === "open" ? "Open" : p.status === "closed" ? "Closed" : "Awarded";
  hl.innerHTML = '<h2>' + esc(p.name || "Project") + '</h2>' +
    '<div class="mh-sub">' + esc(TYPE_LABELS[p.type] || p.type || "") +
    (p.location ? " \u00b7 " + esc(p.location) : "") + " \u00b7 " + esc(statusTxt) + '</div>';
  var x = el("button", "modal-close", "&times;"); x.onclick = closeModal;
  head.appendChild(hl); head.appendChild(x);
  wrap.appendChild(head);

  var body = el("div", "modal-body");
  var grid = el("div", "detail-grid");

  /* ---- LEFT COLUMN: package ---- */
  var left = el("div");

  /* key facts */
  var facts = el("div", "detail-sec");
  facts.innerHTML = '<h4>Project package</h4>';
  var kv = el("div", "kv-list");
  kv.innerHTML =
    row("Submitted by", esc(submitterOrg(p)) +
      ' <span class="kv-role">' + esc(ROLE_LABELS[submitterRole(p)] || "Developer") + '</span>') +
    (isAdmin ? row("Contact", esc(p.submitterEmail || p.developerName || "\u2014")) : "") +
    row("Capacity", fmtKw(p.capacityKw)) +
    row("Cost basis", fmtMoney(p.costBasis)) +
    row("Submitted", esc(fmtDate(p.createdAt)));
  facts.appendChild(kv);
  left.appendChild(facts);

  /* pro forma */
  var pfSec = el("div", "detail-sec");
  pfSec.innerHTML = '<h4>Pro forma summary</h4>' +
    '<div style="font-size:13.5px;line-height:1.6;color:var(--cs-ink)">' + esc(p.proformaSummary || "\u2014") + '</div>';
  left.appendChild(pfSec);

  if (p.notes) {
    var nSec = el("div", "detail-sec");
    nSec.innerHTML = '<h4>Developer notes</h4>' +
      '<div style="font-size:13.5px;line-height:1.6;color:var(--cs-muted)">' + esc(p.notes) + '</div>';
    left.appendChild(nSec);
  }

  /* documents */
  var docSec = el("div", "detail-sec");
  docSec.innerHTML = '<h4>Documents</h4>';
  var docs = p.docs || {};
  var docDefs = DOC_SLOTS;
  var anyDoc = false;
  for (var d = 0; d < docDefs.length; d++) {
    var key = docDefs[d][0], lbl = docDefs[d][1];
    if (docs[key] && docs[key].url) {
      anyDoc = true;
      var a = el("a", "doc-link");
      a.href = docs[key].url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML =
        '<span class="dl-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>' +
        '<span class="dl-name">' + esc(lbl) + " \u2014 " + esc(docs[key].name) + '</span>' +
        '<span class="dl-go">Open &rarr;</span>';
      docSec.appendChild(a);
    }
  }
  if (!anyDoc) { docSec.appendChild(el("div", "doc-missing", "No files uploaded to this submission.")); }

  /* the submitter can add/replace files on their own open deal */
  if (isSeller && !isAwarded) {
    var addBtn = el("button", "btn btn-ghost btn-sm", "Upload / replace files");
    addBtn.style.marginTop = "6px";
    addBtn.onclick = function () { openUploadFilesModal(p); };
    docSec.appendChild(addBtn);
  }
  left.appendChild(docSec);

  /* ---- shared cloud links: utility bills, site details, diligence ---- */
  var linkSec = el("div", "detail-sec");
  linkSec.innerHTML = '<h4>Shared links</h4>';
  var lks = projectLinks(p);
  if (lks.length) {
    for (var li = 0; li < lks.length; li++) {
      var la = el("a", "doc-link link-ext");
      la.href = lks[li].url; la.target = "_blank"; la.rel = "noopener noreferrer";
      la.innerHTML =
        '<span class="dl-ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>' +
        '<span class="dl-name">' + esc(lks[li].label) +
        '<span class="dl-host">' + esc(linkHost(lks[li].url)) + '</span></span>' +
        '<span class="dl-go">Open &rarr;</span>';
      linkSec.appendChild(la);
    }
  } else {
    linkSec.appendChild(el("div", "doc-missing", "No links shared on this submission."));
  }
  if (isSeller && !isAwarded) {
    var editLinks = el("button", "btn btn-ghost btn-sm", lks.length ? "Edit links" : "Add links");
    editLinks.style.marginTop = "6px";
    editLinks.onclick = function () { openLinksModal(p); };
    linkSec.appendChild(editLinks);
  }
  left.appendChild(linkSec);

  grid.appendChild(left);

  /* ---- RIGHT COLUMN: offers + inquiries ---- */
  var right = el("div");

  /* awarded banner */
  if (isAwarded) {
    var ab = el("div");
    ab.style.cssText = "background:var(--cs-green-dim);border:1px solid rgba(18,128,92,.25);border-radius:11px;padding:14px 16px;margin-bottom:18px;";
    var who = (isSeller || isAdmin) ? esc(p.awardedToOrg || "the selected partner")
      : (isAwardedToMe ? "you" : "another partner");
    ab.innerHTML = '<div style="font-family:Syne,sans-serif;font-weight:700;font-size:14px;color:var(--cs-green);margin-bottom:3px;">Awarded</div>' +
      '<div style="font-size:12.5px;color:var(--cs-ink);line-height:1.5;">This project has been awarded to ' + who + '. It is now locked to other partners.</div>';
    right.appendChild(ab);
  }

  /* OFFERS section */
  var offSec = el("div", "detail-sec");
  offSec.innerHTML = '<h4>Offers' + (seesAllOffers ? " (" + offers.length + ")" : "") + '</h4>';

  if (seesAllOffers) {
    /* the submitting side (and admins) see ALL offers */
    if (offers.length === 0) {
      offSec.appendChild(el("div", "doc-missing", "No offers yet. Partners can review and make offers while this stays open."));
    } else {
      /* sort: pending first, newest */
      offers.sort(function (a, b) {
        var pa = a.status === "pending" ? 0 : 1, pb = b.status === "pending" ? 0 : 1;
        if (pa !== pb) { return pa - pb; }
        var ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
        var tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
        return tb - ta;
      });
      for (var o = 0; o < offers.length; o++) {
        offSec.appendChild(offerItem(p, offers[o], false, isSeller));
      }
    }
  } else {
    /* partner sees ONLY their own offer */
    if (myOffer) {
      offSec.appendChild(offerItem(p, myOffer, true, false));
    } else if (!isAwarded) {
      offSec.appendChild(el("div", "doc-missing", "You haven't made an offer on this project yet."));
      var mk = el("button", "btn btn-green btn-sm", "Make an offer");
      mk.style.marginTop = "4px";
      mk.onclick = function () { openOfferModal(p); };
      offSec.appendChild(mk);
    }
  }
  right.appendChild(offSec);

  /* INQUIRIES / thread */
  var inqSec = el("div", "detail-sec");
  inqSec.innerHTML = '<h4>Inquiries</h4>';
  var thread = el("div", "thread"); thread.id = "threadBox";
  if (inqs.length === 0) {
    thread.appendChild(el("div", "doc-missing", "No questions yet."));
  } else {
    for (var q = 0; q < inqs.length; q++) {
      var m = inqs[q];
      var mine = (m.authorUid === STATE.user.uid);
      var mm = el("div", "msg " + (mine ? "me" : "them"));
      mm.innerHTML = '<div class="m-who">' + esc(m.authorName) +
        " \u00b7 " + esc(ROLE_LABELS[m.authorRole] || "Developer") +
        " \u00b7 " + esc(timeAgo(m.createdAt)) + '</div>' + esc(m.body);
      thread.appendChild(mm);
    }
  }
  inqSec.appendChild(thread);

  /* compose inquiry — the submitter on their own deal, or a partner on a deal
     they can still act on. Admins observe without posting. */
  var canInquire = isSeller || (isPartner && (!isAwarded || isAwardedToMe));
  if (canInquire) {
    var comp = el("div", "msg-compose");
    comp.innerHTML = '<input type="text" id="inqInput" placeholder="Ask a question\u2026" maxlength="500">';
    var send = el("button", "btn btn-primary btn-sm", "Send");
    send.onclick = function () { sendInquiry(p._id); };
    comp.appendChild(send);
    inqSec.appendChild(comp);
    setTimeout(function () {
      var inp = $("inqInput");
      if (inp) { inp.onkeydown = function (e) { if (e.key === "Enter") { sendInquiry(p._id); } }; }
    }, 0);
  }
  right.appendChild(inqSec);

  grid.appendChild(right);
  body.appendChild(grid);
  wrap.appendChild(body);

  /* footer actions */
  var foot = el("div", "modal-foot");
  var close = el("button", "btn btn-ghost", "Close"); close.onclick = closeModal;
  foot.appendChild(close);

  /* developer: close their own OPEN project (soft close — removes it from the
     partner pipeline; the developer still sees it under Closed). */
  if (isSeller && p.status === "open") {
    var closeProjBtn = el("button", "btn btn-ghost", "Close to new offers");
    closeProjBtn.onclick = function () { closeProject(p); };
    foot.appendChild(closeProjBtn);
  }

  if (isPartner && !myOffer && !isAwarded) {
    var offerBtn = el("button", "btn btn-green", "Make an offer");
    offerBtn.onclick = function () { openOfferModal(p); };
    foot.appendChild(offerBtn);
  }
  wrap.appendChild(foot);
  openModal(wrap, true);
}

/* ---------- close a project (developer, soft close) ---------- */
function closeProject(p) {
  if (!window.confirm("Close this to new offers? It comes off the partner pipeline and moves to your Closed tab. Offers already in are left as they are.")) { return; }
  db.collection(COL_PROJECTS).doc(p._id)
    .update({ status: "closed", updatedAt: FieldValue.serverTimestamp() })
    .then(function () {
      toast("Closed to new offers.");
      closeModal();
    })
    .catch(function (err) { toast(friendlyAuthError(err), true); });
}

function row(k, v) {
  return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
}


/* ============================================================
   OFFERS — render item + actions (accept / reject / recall)
   ============================================================ */
function offerItem(p, o, mine, canAct) {
  var wrap = el("div", "offer-item" + (mine ? " mine" : ""));

  var stCls = "st-open", stTxt = "Pending";
  if (o.status === "accepted") { stCls = "st-awarded"; stTxt = "Accepted"; }
  else if (o.status === "rejected") { stCls = "st-withdrawn"; stTxt = "Rejected"; }
  else if (o.status === "recalled") { stCls = "st-locked"; stTxt = "Recalled"; }
  else { stCls = "st-offered"; stTxt = "Pending"; }

  var who = mine ? "Your offer" : esc(o.partnerOrg || o.partnerName || "Partner");
  var amt = (o.amount !== null && o.amount !== undefined && o.amount !== "") ? fmtMoney(o.amount) : "\u2014";
  var hold = (o.structure === "long_hold" && o.holdYears) ? (" \u00b7 " + esc(String(o.holdYears)) + "-yr hold") : "";

  var top = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">' +
    '<div style="font-family:Syne,sans-serif;font-weight:700;font-size:14px;">' + who + '</div>' +
    '<span class="status-pill ' + stCls + '">' + esc(stTxt) + '</span>' +
    '</div>';

  var meta = '<div style="font-size:12.5px;color:var(--cs-muted);line-height:1.55;">' +
    '<div><strong style="color:var(--cs-ink)">' + esc(STRUCTURE_LABELS[o.structure] || o.structure || "\u2014") + '</strong>' + hold + '</div>' +
    '<div>Offer: <strong style="color:var(--cs-ink)">' + amt + '</strong></div>' +
    (o.terms ? '<div style="margin-top:5px;">' + esc(o.terms) + '</div>' : "") +
    '<div style="margin-top:5px;color:var(--cs-muted-2);font-size:11.5px;">' + esc(timeAgo(o.createdAt)) + '</div>' +
    '</div>';

  wrap.innerHTML = top + meta;

  /* actions */
  var isPending = (o.status === "pending");
  var isAwarded = (p.status === "awarded");

  if (canAct && isPending && !isAwarded) {
    var acts = el("div");
    acts.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    var acc = el("button", "btn btn-green btn-sm", "Accept &amp; award");
    acc.onclick = function () { acceptOffer(p, o); };
    var rej = el("button", "btn btn-ghost btn-sm", "Reject");
    rej.onclick = function () { rejectOffer(p, o); };
    acts.appendChild(acc); acts.appendChild(rej);
    wrap.appendChild(acts);
  }

  if (isPartnerRole() && mine && isPending && !isAwarded) {
    var pacts = el("div");
    pacts.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    var rc = el("button", "btn btn-ghost btn-sm", "Recall offer");
    rc.onclick = function () { recallOffer(p, o); };
    pacts.appendChild(rc);
    wrap.appendChild(pacts);
  }

  return wrap;
}

/* ---------- make an offer (partner) ---------- */
function openOfferModal(p) {
  var wrap = el("div");
  wrap.appendChild(modalHead("Make an offer", esc(p.name || "Project")));
  var body = el("div", "modal-body");

  var form = el("div");
  form.innerHTML =
    '<div class="field"><label>Structure</label>' +
      '<select id="o-structure">' +
        '<option value="long_hold">Long-hold ownership</option>' +
        '<option value="acquisition">Acquisition</option>' +
        '<option value="debt">Project debt</option>' +
        '<option value="tax_equity">Tax equity</option>' +
      '</select></div>' +
    '<div class="field" id="o-holdWrap"><label>Hold horizon (years)</label>' +
      '<input type="number" id="o-hold" min="1" max="40" placeholder="e.g. 10"></div>' +
    '<div class="field"><label>Offer amount (USD)</label>' +
      '<input type="number" id="o-amount" min="0" step="1000" placeholder="e.g. 2500000"></div>' +
    '<div class="field"><label>Terms &amp; conditions</label>' +
      '<textarea id="o-terms" rows="4" maxlength="1200" placeholder="Structure notes, contingencies, timeline, diligence requirements\u2026"></textarea></div>';
  body.appendChild(form);
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var send = el("button", "btn btn-green", "Submit offer");
  send.onclick = function () { submitOffer(p, send); };
  foot.appendChild(cancel); foot.appendChild(send);
  wrap.appendChild(foot);

  openModal(wrap, false);

  setTimeout(function () {
    var sel = $("o-structure");
    var toggle = function () {
      var hw = $("o-holdWrap");
      if (!hw) { return; }
      hw.style.display = (sel.value === "long_hold") ? "block" : "none";
    };
    if (sel) { sel.onchange = toggle; toggle(); }
  }, 0);
}

function submitOffer(p, btn) {
  var structure = $("o-structure").value;
  var amount = $("o-amount").value;
  var hold = $("o-hold").value;
  var terms = $("o-terms").value.trim();

  if (!amount) { toast("Enter an offer amount.", true); return; }

  btn.disabled = true; btn.textContent = "Submitting\u2026";

  var offer = {
    partnerUid: STATE.user.uid,
    partnerOrg: STATE.profile.org || "",
    partnerName: STATE.profile.name || STATE.profile.email,
    amount: Number(amount),
    structure: structure,
    holdYears: (structure === "long_hold" && hold) ? Number(hold) : null,
    terms: terms,
    status: "pending",
    createdAt: FieldValue.serverTimestamp()
  };

  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  /* one offer per partner: use partnerUid as the offer doc id so a
     partner updates (rather than duplicates) their standing offer. */
  var offerRef = projRef.collection("offers").doc(STATE.user.uid);

  /* Project status is NOT changed here — it stays 'open' to all partners.
     This partner's offer (offers/{uid}) now carries the 'pending' state, which
     their own card/detail reflects. Only the developer changes project status
     (award or close). */
  offerRef.set(offer).then(function () {
    toast("Offer submitted.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = "Submit offer";
    toast(friendlyAuthError(err), true);
  });
}

/* ---------- accept an offer -> award + lock (developer) ---------- */
function acceptOffer(p, o) {
  if (!window.confirm("Award this project to " + (o.partnerOrg || o.partnerName || "this partner") +
    "? This locks the project and removes it from every other partner's view.")) { return; }

  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  var offerRef = projRef.collection("offers").doc(o._id);

  db.runTransaction(function (tx) {
    return tx.get(projRef).then(function (snap) {
      if (!snap.exists) { throw new Error("Project no longer exists."); }
      var data = snap.data();
      if (data.status === "awarded") { throw new Error("This project has already been awarded."); }
      tx.update(projRef, {
        status: "awarded",
        awardedTo: o.partnerUid,
        awardedToOrg: o.partnerOrg || o.partnerName || "",
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.update(offerRef, { status: "accepted" });
      return true;
    });
  }).then(function () {
    /* mark all other pending offers rejected (best-effort, outside tx) */
    return projRef.collection("offers").where("status", "==", "pending").get().then(function (snap) {
      var batch = db.batch();
      snap.forEach(function (d) {
        if (d.id !== o._id) { batch.update(d.ref, { status: "rejected" }); }
      });
      return batch.commit();
    });
  }).then(function () {
    toast("Project awarded and locked.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) {
    toast(friendlyAuthError(err), true);
  });
}

/* ---------- reject an offer (developer) ---------- */
function rejectOffer(p, o) {
  if (!window.confirm("Reject this offer?")) { return; }
  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  /* Project stays 'open' to everyone; only this offer becomes 'rejected'. */
  projRef.collection("offers").doc(o._id).update({ status: "rejected" }).then(function () {
    toast("Offer rejected.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) { toast(friendlyAuthError(err), true); });
}

/* ---------- recall an offer (partner) ---------- */
function recallOffer(p, o) {
  if (!window.confirm("Recall your offer?")) { return; }
  var projRef = db.collection(COL_PROJECTS).doc(p._id);
  projRef.collection("offers").doc(o._id).update({ status: "recalled" }).then(function () {
    toast("Offer recalled.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) { toast(friendlyAuthError(err), true); });
}

/* ============================================================
   INQUIRIES — post a message to the thread
   ============================================================ */
function sendInquiry(pid) {
  var inp = $("inqInput");
  if (!inp) { return; }
  var body = inp.value.trim();
  if (!body) { return; }
  inp.value = "";

  var msg = {
    authorUid: STATE.user.uid,
    authorName: STATE.profile.name || STATE.profile.email,
    authorRole: STATE.role,
    body: body,
    createdAt: FieldValue.serverTimestamp()
  };

  db.collection(COL_PROJECTS).doc(pid).collection("inquiries").add(msg).then(function () {
    openDetail(pid); /* refresh thread */
  }).catch(function (err) {
    toast(friendlyAuthError(err), true);
  });
}

/* ============================================================
   UPLOAD / REPLACE FILES — developer, own open project
   ============================================================ */
function openUploadFilesModal(p) {
  PENDING_FILES = {};
  var wrap = el("div");
  wrap.appendChild(modalHead("Upload / replace files", esc(p.name || "Project")));
  var body = el("div", "modal-body");

  body.appendChild(fileDropField("sitemap", "Site map", "PDF, PNG, or export from the SiteMap Designer"));
  body.appendChild(fileDropField("cost", "Cost basis", "Spreadsheet or PDF of the project cost stack"));
  body.appendChild(fileDropField("proforma", "Pro forma", "Financial model (XLSX) or PDF"));

  var note = el("div", "doc-missing", "Only the files you attach here will be replaced. Leave a slot empty to keep the existing document.");
  note.style.marginTop = "6px";
  body.appendChild(note);
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var save = el("button", "btn btn-primary", "Upload files");
  save.onclick = function () { doUploadFiles(p, save); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);

  openModal(wrap, false);
}

function doUploadFiles(p, btn) {
  var keys = ["sitemap", "cost", "proforma"];
  var uploads = [];
  for (var i = 0; i < keys.length; i++) {
    (function (k) {
      var file = PENDING_FILES[k];
      if (!file) { return; }
      var path = "fin_projects/" + p._id + "/" + k + "_" + Date.now() + "_" + file.name;
      var task = storage.ref(path).put(file).then(function (snap) {
        return snap.ref.getDownloadURL().then(function (url) {
          return { key: k, meta: { name: file.name, url: url, path: path } };
        });
      });
      uploads.push(task);
    })(keys[i]);
  }

  if (uploads.length === 0) { toast("No files selected.", true); return; }

  btn.disabled = true; btn.textContent = "Uploading\u2026";

  Promise.all(uploads).then(function (results) {
    var patch = {};
    for (var j = 0; j < results.length; j++) {
      patch["docs." + results[j].key] = results[j].meta;
    }
    patch.updatedAt = FieldValue.serverTimestamp();
    return db.collection(COL_PROJECTS).doc(p._id).update(patch);
  }).then(function () {
    PENDING_FILES = {};
    toast("Files updated.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = "Upload files";
    toast(friendlyAuthError(err), true);
  });
}


/* ============================================================
   EDIT SHARED LINKS — submitter, own pre-award deal
   ============================================================ */
function openLinksModal(p) {
  var wrap = el("div");
  wrap.appendChild(modalHead("Shared links", esc(p.name || "Project")));
  var body = el("div", "modal-body");
  body.appendChild(linksField(projectLinks(p),
    "Links partners can open",
    "Utility bills, site details, diligence folders \u2014 anything already living in the cloud. Check the sharing setting before you save: if it's restricted, partners see a permission wall instead of your deal."));
  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var save = el("button", "btn btn-primary", "Save links");
  save.onclick = function () { doSaveLinks(p, save); };
  foot.appendChild(cancel); foot.appendChild(save);
  wrap.appendChild(foot);

  openModal(wrap, false);
}

function doSaveLinks(p, btn) {
  var read = readLinkRows();
  if (read.bad.length) {
    toast("Links need to start with http:// or https:// \u2014 check " + read.bad[0], true);
    return;
  }
  btn.disabled = true; btn.textContent = "Saving\u2026";
  db.collection(COL_PROJECTS).doc(p._id).update({
    links: read.links,
    updatedAt: FieldValue.serverTimestamp()
  }).then(function () {
    toast("Links saved.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = "Save links";
    toast(friendlyAuthError(err), true);
  });
}

/* ============================================================
   ADMIN — spreadsheet view, filters, CSV export
   ------------------------------------------------------------
   ADMIN_COLS is the single source of truth for both the on-screen
   table and the CSV, so the two can never drift apart. Each column
   supplies get() for plain text; html() is optional and only affects
   the rendered table.
   ============================================================ */
function adminDate(p) {
  if (!p.createdAt) { return ""; }
  var d = p.createdAt.toDate ? p.createdAt.toDate() : new Date(p.createdAt);
  var mm = String(d.getMonth() + 1); if (mm.length < 2) { mm = "0" + mm; }
  var dd = String(d.getDate()); if (dd.length < 2) { dd = "0" + dd; }
  return d.getFullYear() + "-" + mm + "-" + dd;
}
function docUrl(p, k) {
  var docs = p.docs || {};
  return (docs[k] && docs[k].url) ? docs[k].url : "";
}
function flattenLinks(p) {
  var l = projectLinks(p), out = [];
  for (var i = 0; i < l.length; i++) { out.push(l[i].label + ": " + l[i].url); }
  return out.join(" | ");
}
function statusLabel(s) {
  if (s === "open") { return "Open"; }
  if (s === "closed") { return "Closed"; }
  if (s === "awarded") { return "Awarded"; }
  return s || "";
}

var ADMIN_COLS = [
  { key: "name", label: "Deal", cls: "c-name",
    get: function (p) { return p.name || "Untitled"; },
    sort: function (p) { return (p.name || "").toLowerCase(); } },
  { key: "submitter", label: "Submitted by",
    get: function (p) { return submitterName(p); },
    sort: function (p) { return submitterName(p).toLowerCase(); } },
  { key: "org", label: "Organization",
    get: function (p) { return p.developerOrg || ""; },
    sort: function (p) { return (p.developerOrg || "").toLowerCase(); } },
  { key: "srole", label: "Acting as",
    get: function (p) { return ROLE_LABELS[submitterRole(p)] || "Developer"; },
    html: function (p) {
      var r = submitterRole(p);
      return '<span class="sheet-role r-' + esc(r) + '">' + esc(ROLE_LABELS[r] || "Developer") + '</span>';
    },
    sort: function (p) { return submitterRole(p); } },
  { key: "email", label: "Contact",
    get: function (p) { return p.submitterEmail || ""; },
    sort: function (p) { return (p.submitterEmail || "").toLowerCase(); } },
  { key: "type", label: "Type",
    get: function (p) { return TYPE_LABELS[p.type] || p.type || ""; },
    sort: function (p) { return TYPE_LABELS[p.type] || p.type || ""; } },
  { key: "location", label: "Location",
    get: function (p) { return p.location || ""; },
    sort: function (p) { return (p.location || "").toLowerCase(); } },
  { key: "capacityKw", label: "Capacity (kW)", num: true,
    get: function (p) { return (p.capacityKw || p.capacityKw === 0) ? String(p.capacityKw) : ""; },
    sort: function (p) { return Number(p.capacityKw) || 0; } },
  { key: "costBasis", label: "Cost basis (USD)", num: true,
    get: function (p) { return (p.costBasis || p.costBasis === 0) ? String(p.costBasis) : ""; },
    html: function (p) { return esc(fmtMoney(p.costBasis)); },
    sort: function (p) { return Number(p.costBasis) || 0; } },
  { key: "status", label: "Status",
    get: function (p) { return statusLabel(p.status); },
    html: function (p) {
      var cls = p.status === "open" ? "st-open" : p.status === "awarded" ? "st-awarded" : "st-locked";
      return '<span class="status-pill ' + cls + '">' + esc(statusLabel(p.status)) + '</span>';
    },
    sort: function (p) { return p.status || ""; } },
  { key: "offerCount", label: "Offers", num: true,
    get: function (p) { return String(p.offerCount || 0); },
    sort: function (p) { return Number(p.offerCount) || 0; } },
  { key: "awardedToOrg", label: "Awarded to",
    get: function (p) { return p.awardedToOrg || ""; },
    sort: function (p) { return (p.awardedToOrg || "").toLowerCase(); } },
  { key: "createdAt", label: "Submitted",
    get: function (p) { return adminDate(p); },
    sort: function (p) { return (p.createdAt && p.createdAt.seconds) ? p.createdAt.seconds : 0; } },
  { key: "files", label: "Files", num: true,
    get: function (p) { return String(countDocs(p)); },
    html: function (p) { return adminAttachCell(p, "docs"); },
    sort: function (p) { return countDocs(p); } },
  { key: "links", label: "Links", num: true,
    get: function (p) { return String(countLinks(p)); },
    html: function (p) { return adminAttachCell(p, "links"); },
    sort: function (p) { return countLinks(p); } }
];

/* URL columns live in the CSV only — they would make the table unreadable,
   but they are the whole point of the export. */
var ADMIN_CSV_EXTRA = [
  { label: "Site map URL", get: function (p) { return docUrl(p, "sitemap"); } },
  { label: "Cost basis URL", get: function (p) { return docUrl(p, "cost"); } },
  { label: "Pro forma URL", get: function (p) { return docUrl(p, "proforma"); } },
  { label: "Shared links", get: function (p) { return flattenLinks(p); } },
  { label: "Pro forma summary", get: function (p) { return p.proformaSummary || ""; } },
  { label: "Notes", get: function (p) { return p.notes || ""; } },
  { label: "Deal ID", get: function (p) { return p._id || ""; } }
];

/* small clickable chips inside the Files / Links cells */
function adminAttachCell(p, which) {
  var items = [];
  if (which === "docs") {
    for (var i = 0; i < DOC_SLOTS.length; i++) {
      var u = docUrl(p, DOC_SLOTS[i][0]);
      if (u) { items.push({ label: DOC_SLOTS[i][1], url: u }); }
    }
  } else {
    items = projectLinks(p);
  }
  if (!items.length) { return '<span class="sheet-dash">\u2014</span>'; }
  var html = "";
  for (var j = 0; j < items.length; j++) {
    html += '<a class="sheet-chip" href="' + esc(items[j].url) +
      '" target="_blank" rel="noopener noreferrer" title="' + esc(items[j].url) +
      '" onclick="event.stopPropagation();">' + esc(items[j].label) + '</a>';
  }
  return html;
}

/* ---------- filtering ---------- */
function adminRows() {
  var rows = filteredProjects();   /* respects the status tab */
  var f = STATE.adminFilters;
  var q = (f.q || "").toLowerCase();

  rows = rows.filter(function (p) {
    if (f.submitter && submitterKey(p) !== f.submitter) { return false; }
    if (f.role && submitterRole(p) !== f.role) { return false; }
    if (f.status && (p.status || "") !== f.status) { return false; }
    if (f.type && (p.type || "") !== f.type) { return false; }
    if (q) {
      var hay = [
        p.name, p.developerOrg, p.developerName, p.submitterEmail,
        p.location, p.proformaSummary, p.notes, p.awardedToOrg
      ].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) { return false; }
    }
    return true;
  });

  var col = null;
  for (var i = 0; i < ADMIN_COLS.length; i++) {
    if (ADMIN_COLS[i].key === STATE.adminSort.key) { col = ADMIN_COLS[i]; }
  }
  if (col) {
    var dir = STATE.adminSort.dir;
    rows.sort(function (a, b) {
      var va = col.sort(a), vb = col.sort(b);
      if (va < vb) { return -1 * dir; }
      if (va > vb) { return 1 * dir; }
      return 0;
    });
  }
  return rows;
}

/* ---------- shell ---------- */
function renderAdminTable(area) {
  if (!$("adminSheet")) { buildAdminShell(area); }
  refreshSubmitterOptions();
  renderAdminRows();
}

function buildAdminShell(area) {
  area.innerHTML = "";

  var bar = el("div", "admin-toolbar");

  var search = document.createElement("input");
  search.type = "search"; search.id = "adminQ"; search.className = "admin-search";
  search.placeholder = "Search deals, people, organizations, locations\u2026";
  search.value = STATE.adminFilters.q;
  search.oninput = function () {
    STATE.adminFilters.q = search.value;
    renderAdminRows();
  };
  bar.appendChild(search);

  bar.appendChild(adminSelect("adminSubmitter", "submitter", "Everyone", []));
  bar.appendChild(adminSelect("adminRole", "role", "Any role", [
    { v: "developer", l: "Developers" },
    { v: "originator", l: "Originators" }
  ]));
  bar.appendChild(adminSelect("adminType", "type", "Any type", (function () {
    var o = [], k;
    for (k in TYPE_LABELS) { if (TYPE_LABELS.hasOwnProperty(k)) { o.push({ v: k, l: TYPE_LABELS[k] }); } }
    return o;
  })()));

  var clear = el("button", "btn btn-ghost btn-sm", "Clear");
  clear.onclick = function () {
    STATE.adminFilters = { q: "", submitter: "", role: "", status: "", type: "" };
    $("adminQ").value = "";
    $("adminSubmitter").value = ""; $("adminRole").value = ""; $("adminType").value = "";
    renderAdminRows();
  };
  bar.appendChild(clear);

  var exp = el("button", "btn btn-primary btn-sm", "Export CSV");
  exp.id = "adminExport";
  exp.onclick = exportAdminCsv;
  bar.appendChild(exp);

  area.appendChild(bar);

  var stats = el("div", "admin-stats"); stats.id = "adminStats";
  area.appendChild(stats);

  var wrapEl = el("div", "sheet-wrap");
  var table = document.createElement("table");
  table.className = "sheet"; table.id = "adminSheet";

  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  var rowNum = document.createElement("th");
  rowNum.className = "c-num"; rowNum.innerHTML = "#";
  tr.appendChild(rowNum);
  for (var i = 0; i < ADMIN_COLS.length; i++) {
    (function (c) {
      var th = document.createElement("th");
      th.className = (c.cls || "") + (c.num ? " num" : "");
      th.innerHTML = esc(c.label) + '<span class="sort-ind"></span>';
      th.onclick = function () {
        if (STATE.adminSort.key === c.key) { STATE.adminSort.dir *= -1; }
        else { STATE.adminSort.key = c.key; STATE.adminSort.dir = 1; }
        renderAdminRows();
      };
      tr.appendChild(th);
    })(ADMIN_COLS[i]);
  }
  thead.appendChild(tr);
  table.appendChild(thead);

  var tbody = document.createElement("tbody");
  tbody.id = "adminSheetBody";
  table.appendChild(tbody);

  wrapEl.appendChild(table);
  area.appendChild(wrapEl);
}

function adminSelect(id, filterKey, allLabel, opts) {
  var s = document.createElement("select");
  s.id = id; s.className = "admin-select";
  var first = document.createElement("option");
  first.value = ""; first.textContent = allLabel;
  s.appendChild(first);
  for (var i = 0; i < opts.length; i++) {
    var o = document.createElement("option");
    o.value = opts[i].v; o.textContent = opts[i].l;
    s.appendChild(o);
  }
  s.value = STATE.adminFilters[filterKey] || "";
  s.onchange = function () {
    STATE.adminFilters[filterKey] = s.value;
    renderAdminRows();
  };
  return s;
}

/* rebuild the "submitted by" options from live data, keeping the selection */
function refreshSubmitterOptions() {
  var sel = $("adminSubmitter");
  if (!sel) { return; }
  var seen = {}, names = [];
  for (var i = 0; i < STATE.projects.length; i++) {
    var k = submitterKey(STATE.projects[i]);
    if (!seen[k]) { seen[k] = true; names.push(k); }
  }
  names.sort();

  var current = STATE.adminFilters.submitter || "";
  var signature = names.join("\u0000");
  if (sel.getAttribute("data-sig") === signature) { return; }
  sel.setAttribute("data-sig", signature);

  sel.innerHTML = "";
  var first = document.createElement("option");
  first.value = ""; first.textContent = "Everyone";
  sel.appendChild(first);
  for (var j = 0; j < names.length; j++) {
    var o = document.createElement("option");
    o.value = names[j]; o.textContent = names[j];
    sel.appendChild(o);
  }
  /* the selected submitter may have dropped out of the current tab */
  sel.value = current;
  if (sel.value !== current) { STATE.adminFilters.submitter = ""; sel.value = ""; }
}

/* ---------- rows ---------- */
function renderAdminRows() {
  var tbody = $("adminSheetBody");
  if (!tbody) { return; }
  var rows = adminRows();

  /* sort indicators */
  var ths = $("adminSheet").querySelectorAll("thead th");
  for (var t = 1; t < ths.length; t++) {
    var c = ADMIN_COLS[t - 1];
    var ind = ths[t].querySelector(".sort-ind");
    if (!ind) { continue; }
    if (c.key === STATE.adminSort.key) {
      ind.textContent = STATE.adminSort.dir === 1 ? " \u2191" : " \u2193";
      ths[t].className = (ths[t].className.replace(/ sorted/g, "")) + " sorted";
    } else {
      ind.textContent = "";
      ths[t].className = ths[t].className.replace(/ sorted/g, "");
    }
  }

  tbody.innerHTML = "";

  if (!rows.length) {
    var tr0 = document.createElement("tr");
    var td0 = document.createElement("td");
    td0.colSpan = ADMIN_COLS.length + 1;
    td0.className = "sheet-empty";
    td0.textContent = STATE.projects.length
      ? "No deals match these filters."
      : "No deals have been submitted yet.";
    tr0.appendChild(td0); tbody.appendChild(tr0);
  }

  for (var i = 0; i < rows.length; i++) {
    (function (p, idx) {
      var tr = document.createElement("tr");
      tr.onclick = function () { openDetail(p._id); };

      var n = document.createElement("td");
      n.className = "c-num"; n.textContent = String(idx + 1);
      tr.appendChild(n);

      for (var j = 0; j < ADMIN_COLS.length; j++) {
        var c = ADMIN_COLS[j];
        var td = document.createElement("td");
        td.className = (c.cls || "") + (c.num ? " num" : "");
        if (c.html) { td.innerHTML = c.html(p); }
        else { td.textContent = c.get(p); }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    })(rows[i], i);
  }

  renderAdminStats(rows);
}

function renderAdminStats(rows) {
  var box = $("adminStats");
  if (!box) { return; }
  var totalCost = 0, totalKw = 0, offers = 0, withLinks = 0;
  for (var i = 0; i < rows.length; i++) {
    totalCost += Number(rows[i].costBasis) || 0;
    totalKw += Number(rows[i].capacityKw) || 0;
    offers += Number(rows[i].offerCount) || 0;
    if (countLinks(rows[i]) || countDocs(rows[i])) { withLinks++; }
  }
  function stat(k, v) {
    return '<div class="astat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }
  box.innerHTML =
    stat("Showing", rows.length + " of " + STATE.projects.length) +
    stat("Combined capacity", esc(fmtKw(totalKw))) +
    stat("Combined cost basis", esc(fmtMoney(totalCost))) +
    stat("Offers in", String(offers)) +
    stat("With attachments", withLinks + " of " + rows.length);
}

/* ---------- CSV export ---------- */
function csvCell(v) {
  if (v === null || v === undefined) { v = ""; }
  v = String(v);
  /* Neutralise spreadsheet formula injection: a cell opening with = + - @
     is executed by Excel and Sheets on open. */
  if (/^[=+\-@\t\r]/.test(v)) { v = "'" + v; }
  if (v.indexOf('"') > -1 || v.indexOf(",") > -1 || v.indexOf("\n") > -1 || v.indexOf("\r") > -1) {
    v = '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function exportAdminCsv() {
  var rows = adminRows();
  if (!rows.length) { toast("Nothing to export with these filters.", true); return; }

  var cols = ADMIN_COLS.concat(ADMIN_CSV_EXTRA);
  var lines = [];

  var head = [];
  for (var h = 0; h < cols.length; h++) { head.push(csvCell(cols[h].label)); }
  lines.push(head.join(","));

  for (var i = 0; i < rows.length; i++) {
    var line = [];
    for (var j = 0; j < cols.length; j++) { line.push(csvCell(cols[j].get(rows[i]))); }
    lines.push(line.join(","));
  }

  /* BOM so Excel opens it as UTF-8 rather than mangling accents */
  var csv = "\ufeff" + lines.join("\r\n");
  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

  var stamp = new Date();
  var mm = String(stamp.getMonth() + 1); if (mm.length < 2) { mm = "0" + mm; }
  var dd = String(stamp.getDate()); if (dd.length < 2) { dd = "0" + dd; }
  var who = STATE.adminFilters.submitter
    ? "-" + STATE.adminFilters.submitter.replace(/[^A-Za-z0-9]+/g, "_")
    : "";
  var fname = "clearsky-deals" + who + "-" + stamp.getFullYear() + mm + dd + ".csv";

  if (window.navigator && window.navigator.msSaveBlob) {
    window.navigator.msSaveBlob(blob, fname);
  } else {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  toast("Exported " + rows.length + " deal" + (rows.length === 1 ? "" : "s") + ".");
}

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  if (typeof firebase === "undefined" || !firebase.apps.length) {
    var av = document.getElementById("authView");
    if (av) {
      av.innerHTML = '<div style="max-width:440px;margin:80px auto;text-align:center;font-family:Inter,sans-serif;">' +
        '<h2 style="font-family:Syne,sans-serif;">Firebase not configured</h2>' +
        '<p style="color:#5A6B7B;line-height:1.6;">Add your project credentials to <code>firebase-config.js</code>, then reload. See the README for setup.</p></div>';
    }
    return;
  }
  wireAuthUI();
  auth.onAuthStateChanged(onAuth);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
