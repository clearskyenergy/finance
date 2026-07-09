/* ============================================================
   Firebase configuration — Financing Partners Portal
   ------------------------------------------------------------
   Replace the placeholder values below with your project's
   web app config (Firebase console -> Project settings ->
   General -> Your apps -> Web app -> SDK setup and config).

   This portal reuses the ClearSky-OMEGA Firebase project so
   auth and Firestore stay in one place. If you want it fully
   isolated, create a new project and paste its config here.

   NOTE: these values are NOT secret — the web SDK config is
   safe to ship to the browser. Real security comes from the
   Firestore + Storage rules (see firestore.rules / storage.rules).
   ============================================================ */

var firebaseConfig = {
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  authDomain: "clearsky-portal.firebaseapp.com",
  projectId: "clearsky-portal",
  storageBucket: "clearsky-portal.appspot.com",
  messagingSenderId: "REPLACE_WITH_YOUR_SENDER_ID",
  appId: "REPLACE_WITH_YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);

/* Global handles used across app.js */
var auth = firebase.auth();
var db = firebase.firestore();
var storage = firebase.storage();

/* Server timestamp helper */
var FieldValue = firebase.firestore.FieldValue;
