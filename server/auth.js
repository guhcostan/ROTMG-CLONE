'use strict';
// Account registration/login with scrypt password hashing. Sessions are
// persisted in SQLite so logins survive server restarts.
const crypto = require('crypto');
const storage = require('./db');
const { CLASSES, STARTER_CLASSES } = require('./data');

// Set of classIds the account can currently create a character with.
// Starter classes are always available; advanced classes unlock once the
// account has reached level 20 with their prerequisite class.
function unlockedClasses(accountId) {
  const maxed = storage.maxedClasses(accountId);
  const unlocked = new Set(STARTER_CLASSES);
  for (const [id, cls] of Object.entries(CLASSES)) {
    if (cls.unlock && maxed.has(cls.unlock)) unlocked.add(id);
  }
  return unlocked;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

// crude per-IP throttle for the auth endpoints
const attempts = new Map(); // ip -> { n, resetAt }
function throttled(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now > a.resetAt) { a = { n: 0, resetAt: now + 5 * 60 * 1000 }; attempts.set(ip, a); }
  a.n++;
  if (attempts.size > 5000) attempts.clear();
  return a.n > 30;
}

function register(username, password) {
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return { error: 'Nome deve ter 3-16 caracteres (letras, numeros, _)' };
  }
  if (String(password || '').length < 4) {
    return { error: 'Senha deve ter pelo menos 4 caracteres' };
  }
  if (storage.getAccountByName(username)) return { error: 'Nome de usuario ja existe' };
  const salt = crypto.randomBytes(16).toString('hex');
  storage.createAccount(username, salt, hashPassword(password, salt));
  return login(username, password);
}

function login(username, password) {
  const acc = storage.getAccountByName(String(username || '').trim());
  if (!acc) return { error: 'Usuario ou senha invalidos' };
  const hash = hashPassword(String(password || ''), acc.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(acc.hash))) {
    return { error: 'Usuario ou senha invalidos' };
  }
  if (acc.banned) return { error: 'Conta banida' };
  const token = crypto.randomBytes(24).toString('hex');
  storage.createSession(token, acc.id);
  return { token, username: acc.username };
}

function authed(token) {
  const session = storage.getSession(token);
  const acc = session ? storage.getAccountById(session.account_id) : null;
  return acc && !acc.banned ? acc : null;
}

const MAX_CHARS = 3;

function createCharacter(acc, classId) {
  const cls = CLASSES[classId];
  if (!cls) return { error: 'Classe invalida' };
  if (!unlockedClasses(acc.id).has(classId)) {
    return { error: `Classe bloqueada. Leve ${CLASSES[cls.unlock].name} ao nivel 20 para desbloquear.` };
  }
  if (storage.countChars(acc.id) >= MAX_CHARS) return { error: 'Limite de personagens atingido' };
  const ch = {
    classId,
    level: 1, xp: 0, fame: 0,
    stats: Object.assign({}, cls.base),
    hp: cls.base.hp, mp: cls.base.mp,
    equipment: cls.starter.slice(),
    inventory: [null, null, null, null, null, null, null, null],
  };
  ch.id = storage.createChar(acc.id, ch);
  ch.accountId = acc.id;
  return { character: ch };
}

function deleteCharacter(acc, charId) {
  return storage.deleteChar(charId, acc.id)
    ? { ok: true }
    : { error: 'Personagem nao encontrado' };
}

function buryCharacter(acc, ch, killedBy) {
  storage.bury(acc.id, ch, killedBy);
}

module.exports = { register, login, authed, createCharacter, deleteCharacter, buryCharacter, throttled, unlockedClasses, MAX_CHARS };
