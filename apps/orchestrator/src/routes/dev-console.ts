import type { FastifyInstance } from 'fastify';
import { validateWorkspaceId, type WorkspaceRuntimeApi } from '../docker/workspace-runtime';
import type { TokenService } from '../tokens';

export interface DevConsoleDeps {
  runtime: WorkspaceRuntimeApi;
  tokens: TokenService;
}

/**
 * Development-only browser console (`DEV_CONSOLE=true`). Serves a single page that
 * mounts xterm.js against the real WebSocket bridge, so the runtime path can be
 * exercised from a browser before the Next.js app exists. It creates or starts the
 * requested workspace and embeds a one-hour connect token; never enable it on a
 * reachable host. The client script doubles as a reference for the M1 terminal UI
 * (attach/replay, resize, reconnect).
 */
export function registerDevConsole(app: FastifyInstance, deps: DevConsoleDeps): void {
  app.get<{ Querystring: { workspaceId?: string } }>('/dev/console', async (request, reply) => {
    const workspaceId = validateWorkspaceId(request.query.workspaceId ?? 'demo');
    const existing = await deps.runtime.inspect(workspaceId);
    if (!existing) await deps.runtime.create({ workspaceId });
    else if (existing.status !== 'running') await deps.runtime.start(workspaceId);
    await deps.runtime.waitForAgent(workspaceId, 60_000);
    const { token } = await deps.tokens.issueConnectToken(
      { sub: 'dev-console', ws: workspaceId, name: 'Dev Console', role: 'owner', kind: 'user' },
      3600,
    );
    return reply.type('text/html; charset=utf-8').send(renderPage(workspaceId, token));
  });
}

function renderPage(workspaceId: string, token: string): string {
  const injected = `window.NOTEA = ${JSON.stringify({ workspaceId, token })};`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notea dev console · ${escapeHtml(workspaceId)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #101214; color: #d5d8dc; font: 14px system-ui, sans-serif; }
  #bar { height: 40px; box-sizing: border-box; padding: 0 14px; display: flex; gap: 18px; align-items: center; background: #1b1f24; border-bottom: 1px solid #2a2f36; }
  #bar strong { color: #8fd3a8; }
  #bar code { background: #262b31; padding: 2px 6px; border-radius: 4px; }
  #term { height: calc(100% - 40px); padding: 6px; box-sizing: border-box; }
</style>
</head>
<body>
<div id="bar">
  <strong>Notea dev console</strong>
  <span>workspace <code id="ws-id"></code></span>
  <span id="status">connecting…</span>
  <span id="presence"></span>
</div>
<div id="term"></div>
<script>${injected}</script>
<script>
(function () {
  var cfg = window.NOTEA;
  document.getElementById('ws-id').textContent = cfg.workspaceId;
  var statusEl = document.getElementById('status');
  var presenceEl = document.getElementById('presence');
  var term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, theme: { background: '#101214' } });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  fit.fit();

  var ws = null;
  var sessionId = null;
  var reqCounter = 0;
  var retryMs = 1000;

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }
  function nextReqId(prefix) { reqCounter += 1; return prefix + reqCounter; }

  function connect() {
    var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(scheme + '://' + location.host + '/ws/workspaces/' + encodeURIComponent(cfg.workspaceId) + '?token=' + encodeURIComponent(cfg.token));
    ws.onopen = function () { statusEl.textContent = 'connected'; retryMs = 1000; };
    ws.onclose = function (ev) {
      statusEl.textContent = 'disconnected (' + ev.code + '), retrying…';
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      switch (m.type) {
        case 'hello':
          presenceEl.textContent = m.clients.length + ' connected';
          if (sessionId || m.sessions.length > 0) {
            var target = sessionId || m.sessions[0].id;
            send({ type: 'term.attach', reqId: nextReqId('a'), sessionId: target });
          } else {
            send({ type: 'term.create', reqId: nextReqId('c'), cols: term.cols, rows: term.rows, title: 'dev console' });
          }
          break;
        case 'term.created':
          sessionId = m.session.id;
          term.focus();
          break;
        case 'term.attached':
          sessionId = m.session.id;
          term.reset();
          term.write(m.scrollback);
          send({ type: 'term.resize', sessionId: sessionId, cols: term.cols, rows: term.rows });
          term.focus();
          break;
        case 'term.output':
          if (m.sessionId === sessionId) term.write(m.data);
          break;
        case 'term.exit':
          if (m.sessionId === sessionId) { term.write('\\r\\n[session ended]\\r\\n'); sessionId = null; }
          break;
        case 'presence':
          presenceEl.textContent = m.clients.length + ' connected';
          break;
        case 'error':
          term.write('\\r\\n[error ' + m.code + ': ' + m.message + ']\\r\\n');
          break;
      }
    };
  }

  term.onData(function (data) { if (sessionId) send({ type: 'term.input', sessionId: sessionId, data: data }); });
  window.addEventListener('resize', function () {
    fit.fit();
    if (sessionId) send({ type: 'term.resize', sessionId: sessionId, cols: term.cols, rows: term.rows });
  });
  connect();
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}
