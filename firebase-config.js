/* ============================================================
   Firebase configuration — Financing Partners Portal
   ------------------------------------------------------------
   ClearSky-OMEGA · clearsky-portal project.
   These web-SDK values are NOT secret — they are meant to ship
   to the browser. Real security comes from the Firestore +
   Storage rules (firestore.rules / storage.rules).
   ============================================================ */

var firebaseConfig = {
  apiKey: "AIzaSyABoM1lgOYUnd5ZadaoTMhYmA9cHa8Tyo0",
  authDomain: "clearsky-portal.firebaseapp.com",
  projectId: "clearsky-portal",
  storageBucket: "clearsky-portal.firebasestorage.app",
  messagingSenderId: "742134484347",
  appId: "1:742134484347:web:ab0f95fd221536158481de",
  measurementId: "G-8D92GNW555"
};

firebase.initializeApp(firebaseConfig);

/* Global handles used across app.js */
var auth = firebase.auth();
var db = firebase.firestore();
var storage = firebase.storage();

/* Server timestamp helper */
var FieldValue = firebase.firestore.FieldValue;
