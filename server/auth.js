'use strict';
// Account registration/login with scrypt password hashing and in-memory
// session tokens.
const crypto = require('crypto');
const { db, save } = require('./db');
const { CLASSES } = require('./data');

const sessions = new Map(); // token -> username

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function register(username, password) {
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return { error: 'Nome deve ter 3-16 caracteres (letras, numeros, _)' };
  }
  if (String(password || '').length < 4) {
    return { error: 'Senha deve ter pelo menos 4 caracteres' };
  }
  const key = username.toLowerCase();
  if (db.accounts[key]) return { error: 'Nome de usuario ja existe' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.accounts[key] = {
    username, salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    characters: [],
    graveyard: [],
    vault: new Array(16).fill(null),
    nextCharId: 1,
  };
  save();
  return login(username, password);
}

function login(username, password) {
  const acc = db.accounts[String(username || '').trim().toLowerCase()];
  if (!acc) return { error: 'Usuario ou senha invalidos' };
  const hash = hashPassword(String(password || ''), acc.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(acc.hash))) {
    return { error: 'Usuario ou senha invalidos' };
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, acc.username.toLowerCase());
  return { token, username: acc.username };
}

function authed(token) {
  const key = sessions.get(token);
  return key ? db.accounts[key] : null;
}

const MAX_CHARS = 3;

function createCharacter(acc, classId) {
  const cls = CLASSES[classId];
  if (!cls) return { error: 'Classe invalida' };
  if (acc.characters.length >= MAX_CHARS) return { error: 'Limite de personagens atingido' };
  const ch = {
    id: acc.nextCharId++,
    classId,
    level: 1, xp: 0, fame: 0,
    stats: Object.assign({}, cls.base),
    hp: cls.base.hp, mp: cls.base.mp,
    equipment: cls.starter.slice(),
    inventory: [null, null, null, null, null, null, null, null],
    createdAt: Date.now(),
  };
  acc.characters.push(ch);
  save();
  return { character: ch };
}

function deleteCharacter(acc, charId) {
  const i = acc.characters.findIndex(c => c.id === charId);
  if (i === -1) return { error: 'Personagem nao encontrado' };
  acc.characters.splice(i, 1);
  save();
  return { ok: true };
}

function buryCharacter(acc, ch, killedBy) {
  const i = acc.characters.findIndex(c => c.id === ch.id);
  if (i !== -1) acc.characters.splice(i, 1);
  acc.graveyard.push({
    classId: ch.classId, level: ch.level, fame: ch.fame,
    killedBy, diedAt: Date.now(),
  });
  if (acc.graveyard.length > 50) acc.graveyard.shift();
  save();
}

module.exports = { register, login, authed, createCharacter, deleteCharacter, buryCharacter, MAX_CHARS };
