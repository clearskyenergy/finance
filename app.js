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

/* ---------- global state ---------- */
var STATE = {
  user: null,          // firebase user
  profile: null,       // users/{uid} doc data
  role: null,          // "developer" | "partner"
  projects: [],        // loaded project list (role-scoped)
  activeTab: null,     // current filter tab id
  regRole: "developer",// selected role on register form
  unsub: null          // active Firestore listener unsubscribe
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
  $("rolePartner").className = "role-opt" + (role === "partner" ? " sel" : "");
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
  var role = STATE.regRole;
  auth.createUserWithEmailAndPassword(email, pass)
    .then(function (cred) {
      return db.collection("users").doc(cred.user.uid).set({
        name: name, org: org, email: email, role: role,
        createdAt: FieldValue.serverTimestamp()
      });
    })
    .catch(function (err) { showAuthErr(friendlyAuthError(err)); })
    .then(function () { $("registerBtn").disabled = false; });
}

function doGoogle() {
  clearAuthErr();
  var provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider)
    .then(function (result) {
      var u = result.user;
      var ref = db.collection("users").doc(u.uid);
      return ref.get().then(function (snap) {
        if (!snap.exists) {
          /* new Google user -> default to partner role, org from email domain */
          var domain = (u.email || "").split("@")[1] || "";
          return ref.set({
            name: u.displayName || u.email,
            org: domain,
            email: u.email,
            role: STATE.regRole,   // whatever was selected; default developer
            createdAt: FieldValue.serverTimestamp()
          });
        }
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
  db.collection("users").doc(user.uid).get().then(function (snap) {
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
  if (STATE.role === "developer") {
    chip.className = "role-chip dev"; chip.textContent = "Developer";
    $("pageTitle").textContent = "My projects";
    $("pageSub").textContent = "Submit projects and manage the offers on them.";
    $("newProjectBtn").style.display = "inline-flex";
  } else {
    chip.className = "role-chip partner"; chip.textContent = "Capital partner";
    $("pageTitle").textContent = "Open pipeline";
    $("pageSub").textContent = "Underwrite open projects, then offer, decline, or inquire.";
    $("newProjectBtn").style.display = "none";
  }

  $("newProjectBtn").onclick = openSubmitModal;

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
  if (STATE.role === "developer") {
    defs = [
      { id: "all", label: "All projects" },
      { id: "open", label: "Open" },
      { id: "offered", label: "With offers" },
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

function subscribeProjects() {
  if (STATE.unsub) { STATE.unsub(); STATE.unsub = null; }

  var q;
  if (STATE.role === "developer") {
    /* developers see ONLY their own projects */
    q = db.collection("projects").where("developerUid", "==", STATE.user.uid);
  } else {
    /* partners see open + offered projects, PLUS anything awarded to them.
       Firestore can't OR across fields in one query, so we query the
       browsable pool (not awarded) and merge in won projects separately. */
    q = db.collection("projects").where("status", "in", ["open", "offered"]);
  }

  STATE.unsub = q.onSnapshot(function (snap) {
    var list = [];
    snap.forEach(function (doc) {
      var d = doc.data(); d._id = doc.id; list.push(d);
    });

    if (STATE.role === "partner") {
      /* merge in projects awarded to this partner */
      db.collection("projects").where("awardedTo", "==", STATE.user.uid).get()
        .then(function (wonSnap) {
          wonSnap.forEach(function (doc) {
            var d = doc.data(); d._id = doc.id;
            var dup = false;
            for (var k = 0; k < list.length; k++) { if (list[k]._id === d._id) { dup = true; break; } }
            if (!dup) { list.push(d); }
          });
          STATE.projects = list;
          renderList();
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

  if (STATE.role === "developer") {
    if (t === "open") { return p.filter(function (x) { return x.status === "open"; }); }
    if (t === "offered") { return p.filter(function (x) { return x.status === "offered"; }); }
    if (t === "awarded") { return p.filter(function (x) { return x.status === "awarded"; }); }
    return p; /* all */
  } else {
    if (t === "won") { return p.filter(function (x) { return x.awardedTo === uid; }); }
    if (t === "mine") {
      /* projects where this partner has an offer — need offer scan; we
         approximate using a per-project cached flag set when detail loads.
         For a reliable list, we query offers below in renderList. */
      return p.filter(function (x) { return x._hasMyOffer; });
    }
    /* open: browsable, not awarded */
    return p.filter(function (x) { return x.status === "open" || x.status === "offered"; });
  }
}

function updateTabCounts() {
  var p = STATE.projects; var uid = STATE.user.uid;
  function setc(id, n) { var e = $("cnt-" + id); if (e) { e.textContent = n; } }
  if (STATE.role === "developer") {
    setc("all", p.length);
    setc("open", p.filter(function (x) { return x.status === "open"; }).length);
    setc("offered", p.filter(function (x) { return x.status === "offered"; }).length);
    setc("awarded", p.filter(function (x) { return x.status === "awarded"; }).length);
  } else {
    setc("open", p.filter(function (x) { return x.status === "open" || x.status === "offered"; }).length);
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
  if (STATE.role === "developer") {
    if (STATE.activeTab === "all") {
      e.innerHTML = icon + '<h3>No projects yet</h3><p>Submit your first financeable project \u2014 site map, cost basis, and pro forma \u2014 and capital partners can start underwriting it.</p>';
      var b = el("button", "btn btn-primary", "Submit a project");
      b.onclick = openSubmitModal; e.appendChild(b);
    } else {
      e.innerHTML = icon + '<h3>Nothing here</h3><p>No projects match this filter yet.</p>';
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
  var locked = (STATE.role === "partner" && p.status === "awarded" && p.awardedTo !== STATE.user.uid);
  var card = el("div", "proj-card" + (locked ? " locked" : ""));

  var statusCls, statusTxt;
  if (p.status === "open") { statusCls = "st-open"; statusTxt = "Open"; }
  else if (p.status === "offered") { statusCls = "st-offered"; statusTxt = "Offer received"; }
  else if (p.status === "awarded") {
    if (STATE.role === "partner" && p.awardedTo === STATE.user.uid) { statusCls = "st-awarded"; statusTxt = "Awarded to you"; }
    else if (STATE.role === "developer") { statusCls = "st-awarded"; statusTxt = "Awarded"; }
    else { statusCls = "st-locked"; statusTxt = "Awarded \u00b7 sealed"; }
  } else { statusCls = "st-locked"; statusTxt = esc(p.status); }

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

  /* foot */
  var foot = el("div", "pc-foot");
  var offers = el("div", "pc-offers");
  if (STATE.role === "developer") {
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
   SUBMIT PROJECT (developer)
   ============================================================ */
function openSubmitModal() {
  PENDING_FILES = { sitemap: null, cost: null, proforma: null };
  var wrap = el("div");

  wrap.appendChild(modalHead("Submit a project",
    "Attach the site map, cost basis, and pro forma. This becomes the package capital partners underwrite."));

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

  /* file drops */
  body.appendChild(fileDropField("sitemap", "Site map", "PDF, PNG, or exported from the SiteMap Designer"));
  body.appendChild(fileDropField("cost", "Cost basis", "Cost stack workbook or PDF"));
  body.appendChild(fileDropField("proforma", "Pro forma", "Pro forma model (XLSX) or PDF"));

  wrap.appendChild(body);

  var foot = el("div", "modal-foot");
  var cancel = el("button", "btn btn-ghost", "Cancel"); cancel.onclick = closeModal;
  var submit = el("button", "btn btn-primary", "Submit project"); submit.id = "submitProjBtn";
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

  if (!name) { toast("Give the project a name.", true); return; }
  if (!pf) { toast("Add a short pro forma summary.", true); return; }

  var btn = $("submitProjBtn");
  btn.disabled = true; btn.textContent = "Creating\u2026";

  var proj = {
    name: name, type: type, location: loc,
    capacityKw: cap ? Number(cap) : null,
    costBasis: cost ? Number(cost) : null,
    proformaSummary: pf, notes: notes,
    developerUid: STATE.user.uid,
    developerOrg: STATE.profile.org || "",
    developerName: STATE.profile.name || STATE.profile.email,
    status: "open",
    offerCount: 0,
    awardedTo: null,
    awardedToOrg: null,
    docs: {},
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  db.collection("projects").add(proj).then(function (ref) {
    var pid = ref.id;
    /* upload any attached files, then patch docs map */
    var keys = ["sitemap", "cost", "proforma"];
    var uploads = [];
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        var file = PENDING_FILES[k];
        if (!file) { return; }
        var path = "projects/" + pid + "/" + k + "_" + Date.now() + "_" + file.name;
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
      return db.collection("projects").doc(pid).update({ docs: docs });
    }).then(finishSubmit).catch(function (err) {
      toast("Project created, but a file failed to upload: " + friendlyAuthError(err), true);
      closeModal();
    });
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = "Submit project";
    toast(friendlyAuthError(err), true);
  });

  function finishSubmit() {
    toast("Project submitted to the pipeline.");
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

  db.collection("projects").doc(pid).get().then(function (snap) {
    if (!snap.exists) { closeModal(); toast("Project no longer exists.", true); return; }
    var p = snap.data(); p._id = pid;

    /* guard: partner cannot open a deal awarded to someone else */
    if (STATE.role === "partner" && p.status === "awarded" && p.awardedTo !== STATE.user.uid) {
      renderSealed(p); return;
    }

    /* load offers + inquiries */
    var offersP = db.collection("projects").doc(pid).collection("offers").get();
    var inqP = db.collection("projects").doc(pid).collection("inquiries").orderBy("createdAt", "asc").get();
    Promise.all([offersP, inqP]).then(function (res) {
      var offers = []; res[0].forEach(function (d) { var o = d.data(); o._id = d.id; offers.push(o); });
      var inqs = []; res[1].forEach(function (d) { var m = d.data(); m._id = d.id; inqs.push(m); });
      renderDetail(p, offers, inqs);
    }).catch(function (err) {
      /* partner may not be able to read all offers (rules); still show own */
      renderDetail(p, [], []);
      console && console.warn && console.warn(err);
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
  var isDev = (STATE.role === "developer");
  var isOwner = (p.developerUid === STATE.user.uid);
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
  var statusTxt = p.status === "open" ? "Open" : p.status === "offered" ? "Offer received" : "Awarded";
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
    row("Developer", esc(p.developerOrg || p.developerName || "\u2014")) +
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
  var docDefs = [["sitemap", "Site map"], ["cost", "Cost basis"], ["proforma", "Pro forma"]];
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
  if (!anyDoc) { docSec.appendChild(el("div", "doc-missing", "No documents attached to this submission.")); }

  /* developer can add/replace files on own open project */
  if (isDev && isOwner && !isAwarded) {
    var addBtn = el("button", "btn btn-ghost btn-sm", "Upload / replace files");
    addBtn.style.marginTop = "6px";
    addBtn.onclick = function () { openUploadFilesModal(p); };
    docSec.appendChild(addBtn);
  }
  left.appendChild(docSec);

  grid.appendChild(left);

  /* ---- RIGHT COLUMN: offers + inquiries ---- */
  var right = el("div");

  /* awarded banner */
  if (isAwarded) {
    var ab = el("div");
    ab.style.cssText = "background:var(--cs-green-dim);border:1px solid rgba(18,128,92,.25);border-radius:11px;padding:14px 16px;margin-bottom:18px;";
    var who = isDev ? esc(p.awardedToOrg || "the selected partner") : (isAwardedToMe ? "you" : "another partner");
    ab.innerHTML = '<div style="font-family:Syne,sans-serif;font-weight:700;font-size:14px;color:var(--cs-green);margin-bottom:3px;">Awarded</div>' +
      '<div style="font-size:12.5px;color:var(--cs-ink);line-height:1.5;">This project has been awarded to ' + who + '. It is now locked to other partners.</div>';
    right.appendChild(ab);
  }

  /* OFFERS section */
  var offSec = el("div", "detail-sec");
  offSec.innerHTML = '<h4>Offers' + (isDev ? " (" + offers.length + ")" : "") + '</h4>';

  if (isDev) {
    /* developer sees ALL offers */
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
        offSec.appendChild(offerItem(p, offers[o], false));
      }
    }
  } else {
    /* partner sees ONLY their own offer */
    if (myOffer) {
      offSec.appendChild(offerItem(p, myOffer, true));
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
        " \u00b7 " + esc(m.authorRole === "developer" ? "Developer" : "Partner") +
        " \u00b7 " + esc(timeAgo(m.createdAt)) + '</div>' + esc(m.body);
      thread.appendChild(mm);
    }
  }
  inqSec.appendChild(thread);

  /* compose inquiry — allowed for owner-dev, or partner on non-awarded (or their won deal) */
  var canInquire = (isDev && isOwner) || (!isDev && (!isAwarded || isAwardedToMe));
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

  if (!isDev && !myOffer && !isAwarded) {
    var offerBtn = el("button", "btn btn-green", "Make an offer");
    offerBtn.onclick = function () { openOfferModal(p); };
    foot.appendChild(offerBtn);
  }
  wrap.appendChild(foot);
  openModal(wrap, true);
}

function row(k, v) {
  return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
}


/* ============================================================
   OFFERS — render item + actions (accept / reject / recall)
   ============================================================ */
function offerItem(p, o, mine) {
  var wrap = el("div", "offer-item" + (mine ? " mine" : ""));

  var stCls = "st-open", stTxt = "Pending";
  if (o.status === "accepted") { stCls = "st-awarded"; stTxt = "Accepted"; }
  else if (o.status === "rejected") { stCls = "st-withdrawn"; stTxt = "Rejected"; }
  else if (o.status === "recalled") { stCls = "st-locked"; stTxt = "Recalled"; }
  else { stCls = "st-offered"; stTxt = "Pending"; }

  var who = STATE.role === "developer" ? esc(o.partnerOrg || o.partnerName || "Partner") : "Your offer";
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

  if (STATE.role === "developer" && isPending && !isAwarded) {
    var acts = el("div");
    acts.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    var acc = el("button", "btn btn-green btn-sm", "Accept &amp; award");
    acc.onclick = function () { acceptOffer(p, o); };
    var rej = el("button", "btn btn-ghost btn-sm", "Reject");
    rej.onclick = function () { rejectOffer(p, o); };
    acts.appendChild(acc); acts.appendChild(rej);
    wrap.appendChild(acts);
  }

  if (STATE.role === "partner" && mine && isPending && !isAwarded) {
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

  var projRef = db.collection("projects").doc(p._id);
  /* one offer per partner: use partnerUid as the offer doc id so a
     partner updates (rather than duplicates) their standing offer. */
  var offerRef = projRef.collection("offers").doc(STATE.user.uid);

  offerRef.set(offer).then(function () {
    /* flip project to "offered" if still open */
    if (p.status === "open") {
      return projRef.update({ status: "offered", updatedAt: FieldValue.serverTimestamp() });
    }
    return null;
  }).then(function () {
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

  var projRef = db.collection("projects").doc(p._id);
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
  var projRef = db.collection("projects").doc(p._id);
  projRef.collection("offers").doc(o._id).update({ status: "rejected" }).then(function () {
    /* if no pending offers remain, drop project back to "open" */
    return projRef.collection("offers").where("status", "==", "pending").get().then(function (snap) {
      if (snap.empty && p.status === "offered") {
        return projRef.update({ status: "open", updatedAt: FieldValue.serverTimestamp() });
      }
      return null;
    });
  }).then(function () {
    toast("Offer rejected.");
    closeModal();
    openDetail(p._id);
  }).catch(function (err) { toast(friendlyAuthError(err), true); });
}

/* ---------- recall an offer (partner) ---------- */
function recallOffer(p, o) {
  if (!window.confirm("Recall your offer?")) { return; }
  var projRef = db.collection("projects").doc(p._id);
  projRef.collection("offers").doc(o._id).update({ status: "recalled" }).then(function () {
    return projRef.collection("offers").where("status", "==", "pending").get().then(function (snap) {
      if (snap.empty && p.status === "offered") {
        return projRef.update({ status: "open", updatedAt: FieldValue.serverTimestamp() });
      }
      return null;
    });
  }).then(function () {
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

  db.collection("projects").doc(pid).collection("inquiries").add(msg).then(function () {
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
      var path = "projects/" + p._id + "/" + k + "_" + Date.now() + "_" + file.name;
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
    return db.collection("projects").doc(p._id).update(patch);
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
