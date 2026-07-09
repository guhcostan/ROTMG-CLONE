'use strict';
// SQLite storage layer (better-sqlite3, WAL mode). Real tables for accounts,
// sessions, characters, graveyard, vault and guilds. Migrates legacy
// data/db.json automatically on first boot.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'game.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  pet TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  fame INTEGER NOT NULL DEFAULT 0,
  hp REAL NOT NULL,
  mp REAL NOT NULL,
  stats TEXT NOT NULL,      -- JSON {hp,mp,att,def,spd,dex,vit,wis}
  equipment TEXT NOT NULL,  -- JSON [weapon, ability, armor, ring]
  inventory TEXT NOT NULL,  -- JSON [8 slots]
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chars_account ON characters(account_id);
CREATE INDEX IF NOT EXISTS idx_chars_fame ON characters(fame DESC);
CREATE TABLE IF NOT EXISTS graveyard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  fame INTEGER NOT NULL,
  killed_by TEXT NOT NULL,
  died_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grave_account ON graveyard(account_id);
CREATE TABLE IF NOT EXISTS vault (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  slots TEXT NOT NULL      -- JSON [16 slots]
);
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL UNIQUE,
  leader_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  rank TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, account_id)
);
CREATE TABLE IF NOT EXISTS achievements (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  earned_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, code)
);
CREATE TABLE IF NOT EXISTS daily (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_day INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 1
);
`);

// add the tutorial flag to existing databases (no-op once the column exists)
try { db.exec('ALTER TABLE accounts ADD COLUMN tutorial_done INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN title TEXT'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN name_color TEXT'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN pet_level INTEGER NOT NULL DEFAULT 1'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN pet_xp INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }
try { db.exec("ALTER TABLE accounts ADD COLUMN pet_aura TEXT NOT NULL DEFAULT 'heal'"); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN gold INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN skin TEXT'); } catch { /* column already present */ }
try { db.exec('ALTER TABLE accounts ADD COLUMN banned INTEGER NOT NULL DEFAULT 0'); } catch { /* column already present */ }

db.exec(`
CREATE TABLE IF NOT EXISTS bounties (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  data TEXT NOT NULL      -- JSON [{type,target,progress,done}, ...]
);
CREATE TABLE IF NOT EXISTS season_scores (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  fame INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season)
);
CREATE INDEX IF NOT EXISTS idx_season ON season_scores(season, fame DESC);
CREATE TABLE IF NOT EXISTS pass_claims (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  tier INTEGER NOT NULL,
  PRIMARY KEY (account_id, season, tier)
);
CREATE TABLE IF NOT EXISTS dungeon_times (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dungeon TEXT NOT NULL,
  ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, dungeon)
);
CREATE INDEX IF NOT EXISTS idx_dtimes ON dungeon_times(dungeon, ms ASC);
`);

// ---------------------------------------------------------------- migration
const LEGACY = path.join(DATA_DIR, 'db.json');
if (fs.existsSync(LEGACY)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY, 'utf8'));
    const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (username, username_lc, salt, hash, created_at) VALUES (?,?,?,?,?)');
    const insChar = db.prepare(`INSERT INTO characters (account_id, class_id, level, xp, fame, hp, mp, stats, equipment, inventory, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const insGrave = db.prepare('INSERT INTO graveyard (account_id, class_id, level, fame, killed_by, died_at) VALUES (?,?,?,?,?,?)');
    const migrate = db.transaction(() => {
      for (const acc of Object.values(legacy.accounts || {})) {
        const r = insAcc.run(acc.username, acc.username.toLowerCase(), acc.salt, acc.hash, acc.createdAt || Date.now());
        if (!r.changes) continue;
        const id = r.lastInsertRowid;
        for (const ch of acc.characters || []) {
          insChar.run(id, ch.classId, ch.level, ch.xp, ch.fame, ch.hp, ch.mp,
            JSON.stringify(ch.stats), JSON.stringify(ch.equipment), JSON.stringify(ch.inventory), ch.createdAt || Date.now());
        }
        for (const g of acc.graveyard || []) {
          insGrave.run(id, g.classId, g.level, g.fame || 0, g.killedBy || '?', g.diedAt || Date.now());
        }
      }
    });
    migrate();
    fs.renameSync(LEGACY, LEGACY + '.migrated');
    console.log('Dados legados de db.json migrados para SQLite.');
  } catch (e) {
    console.error('Falha ao migrar db.json:', e.message);
  }
}

// ---------------------------------------------------------------- accounts
const q = {
  accByName: db.prepare('SELECT * FROM accounts WHERE username_lc = ?'),
  accById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  insAcc: db.prepare('INSERT INTO accounts (username, username_lc, salt, hash, created_at) VALUES (?,?,?,?,?)'),
  setPet: db.prepare('UPDATE accounts SET pet = ? WHERE id = ?'),
  setPetState: db.prepare('UPDATE accounts SET pet = ?, pet_level = ?, pet_xp = ?, pet_aura = ? WHERE id = ?'),
  setGold: db.prepare('UPDATE accounts SET gold = ? WHERE id = ?'),
  setBanned: db.prepare('UPDATE accounts SET banned = ? WHERE id = ?'),

  insSession: db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,?,?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  delSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  charsOf: db.prepare('SELECT * FROM characters WHERE account_id = ? ORDER BY id'),
  charById: db.prepare('SELECT * FROM characters WHERE id = ? AND account_id = ?'),
  insChar: db.prepare(`INSERT INTO characters (account_id, class_id, level, xp, fame, hp, mp, stats, equipment, inventory, created_at)
    VALUES (@accountId,@classId,@level,@xp,@fame,@hp,@mp,@stats,@equipment,@inventory,@createdAt)`),
  updChar: db.prepare(`UPDATE characters SET level=@level, xp=@xp, fame=@fame, hp=@hp, mp=@mp,
    stats=@stats, equipment=@equipment, inventory=@inventory WHERE id=@id`),
  delChar: db.prepare('DELETE FROM characters WHERE id = ? AND account_id = ?'),
  countChars: db.prepare('SELECT COUNT(*) AS n FROM characters WHERE account_id = ?'),

  insGrave: db.prepare('INSERT INTO graveyard (account_id, class_id, level, fame, killed_by, died_at) VALUES (?,?,?,?,?,?)'),
  gravesOf: db.prepare('SELECT * FROM graveyard WHERE account_id = ? ORDER BY died_at DESC LIMIT 10'),

  getVault: db.prepare('SELECT slots FROM vault WHERE account_id = ?'),
  setVault: db.prepare(`INSERT INTO vault (account_id, slots) VALUES (?,?)
    ON CONFLICT(account_id) DO UPDATE SET slots = excluded.slots`),

  insGuild: db.prepare('INSERT INTO guilds (name, name_lc, leader_id, created_at) VALUES (?,?,?,?)'),
  guildByName: db.prepare('SELECT * FROM guilds WHERE name_lc = ?'),
  guildById: db.prepare('SELECT * FROM guilds WHERE id = ?'),
  guildOf: db.prepare(`SELECT g.*, m.rank FROM guilds g JOIN guild_members m ON m.guild_id = g.id WHERE m.account_id = ?`),
  insMember: db.prepare('INSERT INTO guild_members (guild_id, account_id, rank, joined_at) VALUES (?,?,?,?)'),
  delMember: db.prepare('DELETE FROM guild_members WHERE account_id = ?'),
  membersOf: db.prepare(`SELECT a.username, m.rank FROM guild_members m JOIN accounts a ON a.id = m.account_id WHERE m.guild_id = ?`),
  countMembers: db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?'),
  delGuild: db.prepare('DELETE FROM guilds WHERE id = ?'),

  // classes the account has ever reached level 20 with (alive or in the grave)
  maxedAlive: db.prepare('SELECT DISTINCT class_id FROM characters WHERE account_id = ? AND level >= 20'),
  maxedGrave: db.prepare('SELECT DISTINCT class_id FROM graveyard WHERE account_id = ? AND level >= 20'),

  leaderboard: db.prepare(`SELECT a.username, c.class_id, c.level, c.fame
    FROM characters c JOIN accounts a ON a.id = c.account_id
    ORDER BY c.fame DESC, c.level DESC LIMIT 20`),
  legends: db.prepare(`SELECT a.username, g.class_id, g.level, g.fame, g.killed_by, g.died_at
    FROM graveyard g JOIN accounts a ON a.id = g.account_id
    ORDER BY g.fame DESC LIMIT 20`),

  earnAch: db.prepare('INSERT OR IGNORE INTO achievements (account_id, code, earned_at) VALUES (?,?,?)'),
  achOf: db.prepare('SELECT code FROM achievements WHERE account_id = ?'),
  getDaily: db.prepare('SELECT last_day, streak FROM daily WHERE account_id = ?'),
  setDaily: db.prepare(`INSERT INTO daily (account_id, last_day, streak) VALUES (?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET last_day = excluded.last_day, streak = excluded.streak`),
  setTutorial: db.prepare('UPDATE accounts SET tutorial_done = 1 WHERE id = ?'),
  setCosmetic: db.prepare('UPDATE accounts SET title = ?, name_color = ?, skin = ? WHERE id = ?'),
  bestFame: db.prepare(`SELECT MAX(f) AS best FROM (
    SELECT fame f FROM characters WHERE account_id = @id
    UNION ALL SELECT fame FROM graveyard WHERE account_id = @id)`),
  getBounties: db.prepare('SELECT day, data FROM bounties WHERE account_id = ?'),
  setBounties: db.prepare(`INSERT INTO bounties (account_id, day, data) VALUES (?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET day = excluded.day, data = excluded.data`),
  recordSeason: db.prepare(`INSERT INTO season_scores (account_id, season, fame) VALUES (?,?,?)
    ON CONFLICT(account_id, season) DO UPDATE SET fame = MAX(fame, excluded.fame)`),
  seasonTop: db.prepare(`SELECT a.username, s.fame FROM season_scores s JOIN accounts a ON a.id = s.account_id
    WHERE s.season = ? ORDER BY s.fame DESC LIMIT 10`),
  seasonWinner: db.prepare(`SELECT a.username, s.fame FROM season_scores s JOIN accounts a ON a.id = s.account_id
    WHERE s.season = ? ORDER BY s.fame DESC LIMIT 1`),
  pastSeasons: db.prepare('SELECT DISTINCT season FROM season_scores WHERE season < ? ORDER BY season DESC LIMIT 8'),
  seasonFameOf: db.prepare('SELECT fame FROM season_scores WHERE account_id = ? AND season = ?'),
  claimedTiers: db.prepare('SELECT tier FROM pass_claims WHERE account_id = ? AND season = ?'),
  claimTier: db.prepare('INSERT OR IGNORE INTO pass_claims (account_id, season, tier) VALUES (?,?,?)'),
  recordTime: db.prepare(`INSERT INTO dungeon_times (account_id, dungeon, ms) VALUES (?,?,?)
    ON CONFLICT(account_id, dungeon) DO UPDATE SET ms = MIN(ms, excluded.ms)`),
  bestTime: db.prepare('SELECT ms FROM dungeon_times WHERE account_id = ? AND dungeon = ?'),
  topTimes: db.prepare(`SELECT a.username, t.ms FROM dungeon_times t JOIN accounts a ON a.id = t.account_id
    WHERE t.dungeon = ? ORDER BY t.ms ASC LIMIT 10`),
};

function rowToChar(row) {
  return {
    id: row.id, accountId: row.account_id, classId: row.class_id,
    level: row.level, xp: row.xp, fame: row.fame,
    hp: row.hp, mp: row.mp,
    stats: JSON.parse(row.stats),
    equipment: JSON.parse(row.equipment),
    inventory: JSON.parse(row.inventory),
    createdAt: row.created_at,
  };
}

const storage = {
  // accounts
  getAccountByName: (name) => q.accByName.get(String(name).toLowerCase()),
  getAccountById: (id) => q.accById.get(id),
  createAccount: (username, salt, hash) =>
    q.insAcc.run(username, username.toLowerCase(), salt, hash, Date.now()).lastInsertRowid,
  setPet: (accountId, pet) => q.setPet.run(pet, accountId),
  setPetState: (accountId, pet, level, xp, aura) => q.setPetState.run(pet, level, xp, aura, accountId),
  setGold: (accountId, gold) => q.setGold.run(gold, accountId),
  setBanned: (accountId, banned) => q.setBanned.run(banned ? 1 : 0, accountId),

  // sessions (30 days)
  createSession: (token, accountId) => {
    const now = Date.now();
    q.delSessions.run(now);
    q.insSession.run(token, accountId, now, now + 30 * 24 * 3600 * 1000);
  },
  getSession: (token) => token ? q.getSession.get(token, Date.now()) : null,

  // characters
  listChars: (accountId) => q.charsOf.all(accountId).map(rowToChar),
  getChar: (charId, accountId) => {
    const row = q.charById.get(charId, accountId);
    return row ? rowToChar(row) : null;
  },
  countChars: (accountId) => q.countChars.get(accountId).n,
  maxedClasses: (accountId) => {
    const set = new Set();
    for (const r of q.maxedAlive.all(accountId)) set.add(r.class_id);
    for (const r of q.maxedGrave.all(accountId)) set.add(r.class_id);
    return set;
  },
  createChar: (accountId, ch) => q.insChar.run({
    accountId, classId: ch.classId, level: ch.level, xp: ch.xp, fame: ch.fame,
    hp: ch.hp, mp: ch.mp,
    stats: JSON.stringify(ch.stats),
    equipment: JSON.stringify(ch.equipment),
    inventory: JSON.stringify(ch.inventory),
    createdAt: Date.now(),
  }).lastInsertRowid,
  saveChar: (ch) => q.updChar.run({
    id: ch.id, level: ch.level, xp: ch.xp, fame: ch.fame,
    hp: Math.round(ch.hp), mp: Math.round(ch.mp),
    stats: JSON.stringify(ch.stats),
    equipment: JSON.stringify(ch.equipment),
    inventory: JSON.stringify(ch.inventory),
  }),
  deleteChar: (charId, accountId) => q.delChar.run(charId, accountId).changes > 0,

  // graveyard
  bury: (accountId, ch, killedBy) => {
    const t = db.transaction(() => {
      q.delChar.run(ch.id, accountId);
      q.insGrave.run(accountId, ch.classId, ch.level, ch.fame, killedBy, Date.now());
    });
    t();
  },
  listGraves: (accountId) => q.gravesOf.all(accountId),

  // vault
  getVault: (accountId) => {
    const row = q.getVault.get(accountId);
    if (!row) return new Array(16).fill(null);
    const slots = JSON.parse(row.slots);
    while (slots.length < 16) slots.push(null);
    return slots;
  },
  setVault: (accountId, slots) => q.setVault.run(accountId, JSON.stringify(slots)),

  // guilds
  createGuild: (name, leaderId) => {
    const t = db.transaction(() => {
      const id = q.insGuild.run(name, name.toLowerCase(), leaderId, Date.now()).lastInsertRowid;
      q.insMember.run(id, leaderId, 'leader', Date.now());
      return id;
    });
    return t();
  },
  getGuildByName: (name) => q.guildByName.get(String(name).toLowerCase()),
  getGuildOf: (accountId) => q.guildOf.get(accountId),
  joinGuild: (guildId, accountId) => q.insMember.run(guildId, accountId, 'member', Date.now()),
  leaveGuild: (accountId) => {
    const g = q.guildOf.get(accountId);
    if (!g) return null;
    q.delMember.run(accountId);
    if (q.countMembers.get(g.id).n === 0) q.delGuild.run(g.id);
    return g;
  },
  guildMembers: (guildId) => q.membersOf.all(guildId),

  // rankings
  leaderboard: () => q.leaderboard.all(),
  legends: () => q.legends.all(),

  // tutorial: one-time per account
  setTutorialDone: (accountId) => q.setTutorial.run(accountId),

  // cosmetics: chosen title + name color, and the account's best fame ever
  setCosmetic: (accountId, title, color, skin) => q.setCosmetic.run(title, color, skin, accountId),
  bestFame: (accountId) => q.bestFame.get({ id: accountId }).best || 0,

  // daily bounties (account-wide, reset by day)
  getBounties: (accountId) => { const r = q.getBounties.get(accountId); return r ? { day: r.day, list: JSON.parse(r.data) } : null; },
  setBounties: (accountId, day, list) => q.setBounties.run(accountId, day, JSON.stringify(list)),

  // seasons: best fame per account per season; leaderboard resets each season
  recordSeasonFame: (accountId, season, fame) => q.recordSeason.run(accountId, season, fame),
  seasonLeaderboard: (season) => q.seasonTop.all(season),
  seasonWinner: (season) => q.seasonWinner.get(season),
  pastSeasons: (currentSeason) => q.pastSeasons.all(currentSeason).map(r => r.season),
  seasonFameOf: (accountId, season) => { const r = q.seasonFameOf.get(accountId, season); return r ? r.fame : 0; },
  claimedPassTiers: (accountId, season) => q.claimedTiers.all(accountId, season).map(r => r.tier),
  claimPassTier: (accountId, season, tier) => q.claimTier.run(accountId, season, tier).changes > 0,
  recordDungeonTime: (accountId, dungeon, ms) => q.recordTime.run(accountId, dungeon, ms),
  bestDungeonTime: (accountId, dungeon) => { const r = q.bestTime.get(accountId, dungeon); return r ? r.ms : null; },
  topDungeonTimes: (dungeon) => q.topTimes.all(dungeon),

  // achievements (account-wide, permanent)
  earnAchievement: (accountId, code) => q.earnAch.run(accountId, code, Date.now()).changes > 0,
  listAchievements: (accountId) => q.achOf.all(accountId).map(r => r.code),

  // daily login: returns { claimed, streak } — claimed false if already claimed today
  claimDaily: (accountId) => {
    const today = Math.floor(Date.now() / 86400000);
    const row = q.getDaily.get(accountId);
    if (row && row.last_day === today) return { claimed: false, streak: row.streak };
    const streak = row && row.last_day === today - 1 ? row.streak + 1 : 1;
    q.setDaily.run(accountId, today, streak);
    return { claimed: true, streak };
  },

  close: () => { try { db.close(); } catch {} },
};

module.exports = storage;
