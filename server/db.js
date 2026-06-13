'use strict';
// Tiny JSON-file persistence. Good enough for a hobby server; swap for a
// real database if the player count grows.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const db = {
  accounts: {},   // username -> { username, salt, hash, createdAt, characters: [], graveyard: [], nextCharId }
};

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    Object.assign(db, JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('db load failed:', e.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('db save failed:', e.message);
    }
  }, 500);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  } catch (e) {
    console.error('db save failed:', e.message);
  }
}

load();
module.exports = { db, save, saveNow };
