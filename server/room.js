'use strict';
// Colyseus room that carries the whole game: every client joins the single
// "realm" room and the authoritative Game keeps multiplexing players across
// its internal instances (Nexus, realms, dungeons). The room's synced state
// holds the small global facts (population, season); everything gameplay
// still flows through the existing JSON protocol as room messages.
const { Room, ServerError } = require('colyseus');
const { Schema, defineTypes } = require('@colyseus/schema');
const auth = require('./auth');
const storage = require('./db');

class GlobalState extends Schema {
  constructor() {
    super();
    this.online = 0;
    this.season = '';
    this.seasonModifier = '';
  }
}
defineTypes(GlobalState, { online: 'number', season: 'string', seasonModifier: 'string' });

class RealmRoom extends Room {
  onCreate(options) {
    this.game = options.game;
    this.maxClients = 500;
    this.autoDispose = false;
    this.setState(new GlobalState());
    this.state.season = String(this.game.season);
    this.state.seasonModifier = this.game.seasonMod.name;
    this.clock.setInterval(() => { this.state.online = this.game.players.size; }, 2000);

    // the whole legacy protocol travels as 'g' messages (client -> server
    // objects, server -> client JSON strings via the socket adapter below)
    this.onMessage('g', (client, msg) => {
      if (!client.userData || !msg || typeof msg.t !== 'string') return;
      try { this.game.handle(client.userData.player, msg); }
      catch (e) { console.error('handle error:', e); }
    });
  }

  onAuth(client, options) {
    const acc = auth.authed(options && options.token);
    if (!acc) throw new ServerError(4001, 'unauthorized');
    const char = storage.getChar(parseInt(options.char, 10), acc.id);
    if (!char) throw new ServerError(4002, 'no character');
    for (const p of this.game.players.values()) {
      if (p.char.id === char.id) throw new ServerError(4003, 'already playing');
    }
    return { acc, char };
  }

  onJoin(client, options, authData) {
    // adapter with the ws shape Game expects (readyState + send of a JSON string)
    const sock = {
      readyState: 1,
      send: (str) => { try { client.send('g', str); } catch { /* gone */ } },
    };
    const player = this.game.joinPlayer(sock, authData.acc, authData.char);
    client.userData = { player, sock };
    console.log(`[+] ${authData.acc.username} entrou (${player.char.classId} nv ${player.char.level})`);
  }

  onLeave(client) {
    if (!client.userData) return;
    client.userData.sock.readyState = 3;
    this.game.leavePlayer(client.userData.player);
    console.log(`[-] ${client.userData.player.name} saiu`);
    client.userData = null;
  }
}

module.exports = { RealmRoom };
