'use strict';
// REST helpers + WebSocket game connection.

const Net = (() => {
  let ws = null;
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
    if (ws) ws.close();
  }

  function connect(charId, handlers) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}&char=${charId}`);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const h = handlers[msg.t];
      if (h) h(msg);
    };
    ws.onclose = (ev) => handlers._close && handlers._close(ev);
    ws.onerror = () => {};
    return ws;
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function disconnect() { if (ws) { ws.onclose = null; ws.close(); ws = null; } }

  return {
    api, login, logout, connect, send, disconnect,
    get token() { return token; },
    get username() { return username; },
  };
})();
