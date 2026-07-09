'use strict';
// REST helpers + Colyseus game connection.

const Net = (() => {
  let client = null;
  let room = null;
  let token = localStorage.getItem('token') || null;
  let username = localStorage.getItem('username') || null;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'X-Token': token } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro de rede');
    return data;
  }

  async function login(user, pass, isRegister) {
    const r = await api('POST', isRegister ? '/api/register' : '/api/login', { username: user, password: pass });
    token = r.token; username = r.username;
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    return r;
  }

  function logout() {
    token = null; username = null;
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    disconnect();
  }

  // joins the single Colyseus "realm" room; the legacy game protocol
  // travels as 'g' messages (server sends JSON strings, client sends objects)
  function connect(charId, handlers) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (!client) client = new Colyseus.Client(`${proto}://${location.host}`);
    client.joinOrCreate('realm', { token, char: charId }).then(r => {
      room = r;
      r.onMessage('g', (payload) => {
        let msg = payload;
        if (typeof payload === 'string') {
          try { msg = JSON.parse(payload); } catch { return; }
        }
        const h = handlers[msg.t];
        if (h) h(msg);
      });
      r.onStateChange(state => { if (handlers._state) handlers._state(state); });
      r.onError(() => {});
      r.onLeave(code => { room = null; if (handlers._close) handlers._close({ code }); });
    }).catch(e => {
      room = null;
      if (handlers._close) handlers._close({ code: e.code || 0, reason: e.message });
    });
  }

  function send(msg) {
    if (room && room.connection && room.connection.isOpen) room.send('g', msg);
  }

  function disconnect() {
    if (room) {
      const r = room;
      room = null;
      r.removeAllListeners();
      try { r.leave(); } catch { /* already closed */ }
    }
  }

  return {
    api, login, logout, connect, send, disconnect,
    get token() { return token; },
    get username() { return username; },
  };
})();
