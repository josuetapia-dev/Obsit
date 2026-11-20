// Obsi-boty — main process
// - A small transparent, frameless, always-on-top window hosts the 3D robot (click-through except on the robot).
// - A local HTTP server (127.0.0.1:47321) receives events from the VS Code extension: which file is open, focus.
// - A chat bubble window next to the robot: explanations, free questions, "show me the file that...", quiz mode.
// - The "brain" (brain.js) talks to Claude Code in headless mode, read-only, inside the project folder.

const { app, BrowserWindow, screen, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const brain = require('./brain');

const PORT = 47321;
const QUIZ_EVERY_MS = 25 * 60 * 1000;       // surprise question at most every 25 min…
const QUIZ_FIRST_MS = 10 * 60 * 1000;       // …and never in the first 10 min after starting

// window is a square, in DIPs; the robot scales with it
const SIZES = { mini: 170, pequeno: 220, normal: 300 };
const SIZE_LABELS = { mini: 'Mini', pequeno: 'Pequeño', normal: 'Normal' };
let sizeKey = 'pequeno';
let SIZE = SIZES[sizeKey];
const POS_FILE = () => path.join(app.getPath('userData'), 'position.json');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let win = null, bubble = null;
let dragTimer = null, cursorTimer = null, quizTimer = null;
let bubbleHeight = 160, bubbleOpen = false;
let settings = { lastWorkspace: null, quiz: true, toursOffered: {} };
let lastActivity = Date.now(), lastQuiz = Date.now() - QUIZ_EVERY_MS + QUIZ_FIRST_MS;

// what the VS Code extension last told us
const ctx = { file: null, workspace: null, languageId: null, focused: false };
let busy = false;

// "show me" challenge: Obsi-boty asks you to open a file; we watch what you open in VS Code
let pendingFind = null, findTimer = null;
const wrongTried = new Set();
const FIND_PROMPT = 'Hazme un reto "muéstrame": pídeme que te muestre un archivo del proyecto.';
const QUIZ_PROMPT = 'Hazme una pregunta de examen sobre el proyecto.';
const rel = f => (workspace() ? path.relative(workspace(), f) : path.basename(f)).replace(/\\/g, '/');
const fileRef = f => ({ [rel(f)]: { file: f, line: null } });

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- persistence ----------
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); } catch { /* defaults */ }
}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings)); } catch { /* not critical */ } }

function loadPosition() {
  try {
    const p = JSON.parse(fs.readFileSync(POS_FILE(), 'utf8'));
    if (SIZES[p.size]) { sizeKey = p.size; SIZE = SIZES[sizeKey]; }
    const visible = screen.getAllDisplays().some(d =>
      p.x >= d.workArea.x - SIZE/2 && p.x <= d.workArea.x + d.workArea.width - SIZE/2 &&
      p.y >= d.workArea.y - SIZE/2 && p.y <= d.workArea.y + d.workArea.height - SIZE/2);
    if (visible) return p;
  } catch { /* first run or corrupted file: fall back to the corner */ }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - SIZE - 16, y: wa.y + wa.height - SIZE - 8 };
}

function savePosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  try { fs.writeFileSync(POS_FILE(), JSON.stringify({ x, y, size: sizeKey })); } catch { /* not critical */ }
}

function setSize(key) {
  if (!win || !SIZES[key]) return;
  const b = win.getBounds();
  const cx = b.x + b.width/2, cy = b.y + b.height/2;
  sizeKey = key; SIZE = SIZES[key];
  win.setBounds({ x: Math.round(cx - SIZE/2), y: Math.round(cy - SIZE/2), width: SIZE, height: SIZE });
  placeBubble(); savePosition();
}

const workspace = () => ctx.workspace || settings.lastWorkspace;

// ---------- robot window ----------
function sendState(name, revert = null, ms = 2500) {
  if (win && !win.isDestroyed()) win.webContents.send('state', { name, revert, ms });
}

function createWindow() {
  const pos = loadPosition();
  win = new BrowserWindow({
    width: SIZE, height: SIZE, x: pos.x, y: pos.y,
    transparent: true, backgroundColor: '#00000000',
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: false,                              // never steals focus from VS Code
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });   // click-through; renderer turns it off over the robot
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[robot]', message); });

  // Global cursor: lets the eyes follow the mouse anywhere on screen (and tells us the user is around).
  let last = '';
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const msg = { x: p.x - (b.x + b.width/2), y: p.y - (b.y + b.height/2) };
    const key = `${msg.x},${msg.y}`;
    if (key !== last) { last = key; lastActivity = Date.now(); win.webContents.send('cursor', msg); }
  }, 66);

  createBubble();
  quizTimer = setInterval(maybeSurpriseQuiz, 60 * 1000);

  if (process.env.OBSI_SNAPSHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.OBSI_SNAPSHOT, img.toPNG());
      app.quit();
    }, Number(process.env.OBSI_SNAPSHOT_DELAY || 4000));
  }
}

// ---------- chat bubble window ----------
const BUBBLE_W = 370;
function createBubble() {
  bubble = new BrowserWindow({
    width: BUBBLE_W, height: bubbleHeight, show: false,
    transparent: true, backgroundColor: '#00000000',
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: true,                               // so you can type; it only takes focus when you click it
    webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  bubble.setAlwaysOnTop(true, 'floating');
  bubble.loadFile(path.join(__dirname, 'renderer', 'bubble.html'));
  bubble.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[bubble]', message); });
}

function placeBubble() {
  if (!bubble || !win || !bubbleOpen) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const overlap = Math.round(b.width*0.14);              // the robot window has transparent margins
  let x = b.x - BUBBLE_W + overlap;                      // prefer the left side of the robot
  if (x < wa.x) x = b.x + b.width - overlap;             // no room: right side
  let y = Math.round(b.y + b.height*0.55 - bubbleHeight);  // bottom of the chat near the robot's middle
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - bubbleHeight - 4));
  bubble.setBounds({ x: Math.round(x), y, width: BUBBLE_W, height: bubbleHeight });
}

function openPanel({ focus = false } = {}) {
  if (!bubble) return;
  bubbleOpen = true;
  bubble.webContents.send('open', { focus });
  placeBubble();
  if (focus) { bubble.show(); bubble.focus(); }
  else if (!bubble.isVisible()) bubble.showInactive();
}
function hidePanel() {
  bubbleOpen = false;
  if (bubble && bubble.isVisible()) bubble.hide();
}
const post = m => bubble && bubble.webContents.send('message', m);
const loading = t => bubble && bubble.webContents.send('loading', t);

ipcMain.on('bubble-height', (_e, h) => { bubbleHeight = Math.max(80, Math.min(Math.ceil(h), 520)); placeBubble(); });
ipcMain.on('bubble-close', () => {
  hidePanel();
  if (busy) { brain.cancel(); busy = false; }
  sendState('reposo');
});
ipcMain.on('chat-reset', () => {
  brain.newConversation(); busy = false; endFind();
  bubble.webContents.send('reset');
  sendState('reposo');
});
ipcMain.on('open-file', (_e, { file, line }) => openInVSCode(file, line));
ipcMain.on('chat-send', (_e, text) => chat(text));
ipcMain.on('chat-action', (_e, value) => {
  if (value === 'quiz-yes') chat(QUIZ_PROMPT);
  else if (value === 'find-start') chat(FIND_PROMPT);
  else if (value === 'find-hint') chat('Dame una pista para encontrar el archivo del reto, sin decirme su nombre ni su ruta.');
  else if (value === 'find-giveup') giveUpFind();
  else if (value === 'explain-it') explainCurrent();
  else if (value === 'tour-start') startTour();
  else if (value === 'tour-restart') startTour();
  else if (value === 'tour-next') showTourStep(tour ? tour.i + 1 : 0);
  else if (value === 'tour-prev') showTourStep(tour ? tour.i - 1 : 0);
  else if (value === 'tour-end') { tour = null; post({ role: 'bot', kind: 'hint', text: 'Va. Cuando quieras el tour, búscalo en mi menú (clic derecho → Tour del proyecto).' }); sendState('reposo'); }
  else if (value === 'quiz-no') { hidePanel(); sendState('reposo'); }
  else if (value === 'quiz-off') { settings.quiz = false; saveSettings(); post({ role: 'bot', kind: 'hint', text: 'Listo, ya no te haré preguntas sorpresa. Puedes activarlas otra vez desde mi menú (clic derecho).' }); }
});

// ---------- talking to Claude ----------
function failMessage(e) {
  sendState('confundido', 'reposo', 6000);
  post({ role: 'bot', kind: 'error', text: e.message + (e.code === 'LOGIN' ? '' : ' Inténtalo otra vez.') });
}

function react(res) {
  if (res.grade === 'correcto') sendState('celebrar', 'reposo', 3500);
  else if (res.grade === 'parcial') sendState('curioso', 'reposo', 3000);
  else if (res.grade === 'incorrecto') sendState('ups', 'reposo', 3500);
  else sendState('explicar', 'reposo', 9000);
  if (res.open) openInVSCode(res.open.file, res.open.line);
}

async function chat(text) {
  if (busy || !text) return;
  openPanel();
  post({ role: 'user', text });
  if (!workspace()) { post({ role: 'bot', kind: 'hint', text: 'Todavía no sé cuál es tu proyecto. Abre un archivo de él en VS Code y vuelve a preguntarme.' }); return; }
  busy = true;
  sendState('pensar');
  loading('Pensando (y revisando el proyecto)');
  try {
    const res = await brain.ask({ message: text, workspace: workspace() });
    if (!busy) return;
    if (res.find) {
      startFind(res.find.file);
      post({ role: 'bot', ...res, actions: FIND_ACTIONS });
      sendState('pregunta', 'reposo', 8000);
    } else {
      const actions = pendingFind ? FIND_ACTIONS : undefined;      // a hint keeps the challenge going
      post({ role: 'bot', ...res, actions });
      react(res);
    }
  } catch (e) {
    if (busy && e.code !== 'CANCELLED') failMessage(e);
  } finally { busy = false; loading(null); }
}

async function explainCurrent() {
  if (!ctx.file) { sendState('escuchar', 'reposo', 6000); openPanel({ focus: true }); return; }
  if (busy) return;
  busy = true;
  const file = ctx.file, name = path.basename(file);
  openPanel();
  post({ role: 'user', text: `Explícame ${name}` });
  sendState('escanear');
  loading('Leyendo el archivo');
  const thinkTimer = setTimeout(() => { if (busy) { sendState('pensar'); loading('Pensando qué hace (y buscando en docs/)'); } }, 1800);
  try {
    const res = await brain.explain({ file, workspace: workspace() });
    if (!busy) return;
    post({ role: 'bot', tag: res.cached ? 'guardado · ' + name : name, ...res });
    sendState('explicar', 'reposo', 9000);
  } catch (e) {
    if (busy && e.code !== 'CANCELLED') failMessage(e);
  } finally { clearTimeout(thinkTimer); busy = false; loading(null); }
}

// ---------- "show me" challenge ----------
const FIND_ACTIONS = [{ label: '💡 Dame una pista', value: 'find-hint' }, { label: '🏳️ Me rindo', value: 'find-giveup' }];

function startFind(file) { pendingFind = { file }; wrongTried.clear(); clearTimeout(findTimer); }
function endFind() { pendingFind = null; wrongTried.clear(); clearTimeout(findTimer); }

// called a moment after you switch files in VS Code (so quick browsing doesn't count)
function checkFind() {
  const f = ctx.file;
  if (!pendingFind || !f || busy) return;
  openPanel();
  if (brain.samePath(f, pendingFind.file)) {
    endFind();
    sendState('celebrar', 'reposo', 4000);
    post({ role: 'bot', text: `¡Exacto! Ese es \`${rel(f)}\`. 🎉 Sabes moverte por el proyecto.`, files: fileRef(f), grade: 'correcto',
      actions: [{ label: 'Otro reto', value: 'find-start' }, { label: 'Explícamelo', value: 'explain-it' }] });
  } else if (!wrongTried.has(f.toLowerCase()) && wrongTried.size < 3) {
    wrongTried.add(f.toLowerCase());
    sendState('confundido', 'reposo', 2500);
    post({ role: 'bot', text: `Mmm, \`${rel(f)}\` no es el que busco. 🤔 Sigue buscando.`, files: fileRef(f), actions: FIND_ACTIONS });
  }
}

function giveUpFind() {
  if (!pendingFind) return;
  const f = pendingFind.file;
  endFind();
  sendState('ups', 'reposo', 3000);
  post({ role: 'bot', text: `Era \`${rel(f)}\`. Te lo abro para que lo veas. 📂`, files: fileRef(f), grade: 'incorrecto',
    actions: [{ label: 'Otro reto', value: 'find-start' }, { label: 'Explícamelo', value: 'explain-it' }] });
  openInVSCode(f);
}

// ---------- guided tour ----------
let tour = null;           // { intro, flow, steps:[{abs, rel, kind, line, endLine, title, text}], i }

async function startTour({ fresh = false } = {}) {
  if (busy) return;
  endFind();
  openPanel();
  post({ role: 'user', text: fresh ? 'Prepara el tour otra vez' : 'Dame un tour del proyecto' });
  if (!workspace()) { post({ role: 'bot', kind: 'hint', text: 'Primero abre un archivo de tu proyecto en VS Code, así sé cuál recorrer.' }); return; }
  busy = true;
  sendState('escanear');
  loading('Preparando el tour: estoy revisando todo el proyecto (la primera vez tarda 1-2 minutos)');
  const t = setTimeout(() => busy && sendState('pensar'), 4000);
  try {
    const res = await brain.makeTour(workspace(), { fresh });
    if (!busy) return;
    tour = { ...res, i: -1 };
    sendState('saludar', 'reposo', 2500);
    post({ role: 'bot', tag: `Tour · ${res.steps.length} paradas`, text: `${res.intro}\n\nVoy a ir abriendo cada parada en VS Code. Tú me dices cuándo avanzar.`,
      actions: [{ label: '▶ Empezar', value: 'tour-next' }, { label: 'Más tarde', value: 'tour-end' }] });
  } catch (e) {
    if (busy && e.code !== 'CANCELLED') failMessage(e);
  } finally { clearTimeout(t); busy = false; loading(null); }
}

function showTourStep(i) {
  if (!tour) return;
  if (i >= tour.steps.length) return finishTour();
  tour.i = Math.max(0, i);
  const s = tour.steps[tour.i], n = tour.steps.length;
  openPanel();
  if (s.kind === 'folder') revealInVSCode(s.abs); else openInVSCode(s.abs, s.line, s.endLine);
  sendState('explicar', 'reposo', 12000);
  const actions = [];
  if (tour.i > 0) actions.push({ label: '◀ Anterior', value: 'tour-prev' });
  actions.push({ label: tour.i === n - 1 ? 'Ver el flujo completo ▶' : 'Siguiente ▶', value: 'tour-next' });
  actions.push({ label: 'Terminar', value: 'tour-end' });
  post({ role: 'bot', tag: `Parada ${tour.i + 1} de ${n} · ${s.kind === 'folder' ? '📁' : '📄'} ${s.title}`,
    text: `\`${s.rel}\`\n\n${s.text}`, files: s.kind === 'file' ? { [s.rel]: { file: s.abs, line: s.line } } : {}, actions });
}

function finishTour() {
  if (!tour) return;
  settings.toursOffered[path.resolve(workspace()).toLowerCase()] = 'done'; saveSettings();
  sendState('celebrar', 'reposo', 4000);
  post({ role: 'bot', tag: 'Fin del tour · así fluye la app', text: `${tour.flow}\n\n¡Listo! Con esto ya puedes defender lo esencial. 🎓`,
    actions: [{ label: 'Hazme una pregunta', value: 'quiz-yes' }, { label: 'Reto: muéstrame', value: 'find-start' }, { label: 'Repetir tour', value: 'tour-restart' }] });
  tour = null;
}

// first time we see a project, offer the tour
function maybeOfferTour() {
  const ws = workspace();
  if (!ws || busy || bubbleOpen || tour) return;
  const key = path.resolve(ws).toLowerCase();
  if (settings.toursOffered[key]) return;
  settings.toursOffered[key] = 'offered'; saveSettings();
  setTimeout(() => {
    sendState('saludar', 'reposo', 3000);
    openPanel();
    post({ role: 'bot', text: `¡Hola! Soy Obsi-boty 🤖, el compañero del equipo Obsi. Veo que abriste **${path.basename(ws)}**. ¿Te doy un tour por lo que sí o sí tienes que conocer del proyecto? Voy abriendo cada archivo en VS Code y te explico el flujo de la app.`,
      actions: [{ label: 'Sí, dame el tour', value: 'tour-start' }, { label: 'Más tarde', value: 'tour-end' }] });
  }, 2500);
}

// ---------- opening things in VS Code ----------
// Preferred: ask the extension (it can highlight lines and reveal folders). Fallback: the `code` command.
function vscodeCommand(cmd) {
  return new Promise(resolve => {
    const data = JSON.stringify(cmd);
    const req = http.request({ host: '127.0.0.1', port: 47322, path: '/cmd', method: 'POST', timeout: 2500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); resolve(res.statusCode < 300); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(data);
  });
}

async function revealInVSCode(folder) {
  if (!(await vscodeCommand({ cmd: 'reveal', path: folder }))) console.error('[code] could not reveal folder (extension not reachable)');
}

async function openInVSCode(file, line, endLine) {
  if (!file || !fs.existsSync(file)) return;
  if (await vscodeCommand({ cmd: 'open', path: file, line, endLine })) return;
  const target = line ? `${file}:${line}` : file;
  const child = spawn('code', ['-g', `"${target}"`], { shell: true, windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', e => console.error('[code]', e.message));
  child.unref();
}

// ---------- surprise quiz ----------
function maybeSurpriseQuiz() {
  const now = Date.now();
  if (!settings.quiz || bubbleOpen || busy || !workspace()) return;
  if (now - lastQuiz < QUIZ_EVERY_MS || now - lastActivity > 60 * 1000) return;   // only when you're around
  lastQuiz = now;
  sendState('pregunta', 'reposo', 12000);
  openPanel();
  post({ role: 'bot', text: '¿Te hago una pregunta rápida del proyecto? Así practicas para la presentación. 🎓',
    actions: [{ label: 'Sí, pregúntame', value: 'quiz-yes' }, { label: 'Reto: muéstrame un archivo', value: 'find-start' }, { label: 'Ahora no', value: 'quiz-no' }, { label: 'No vuelvas a preguntar', value: 'quiz-off' }] });
}

ipcMain.on('robot-click', () => {
  if (bubbleOpen && !busy) { hidePanel(); sendState('reposo'); return; }   // second click closes the chat
  if (busy) { openPanel(); return; }
  sendState('sorpresa');
  setTimeout(explainCurrent, 600);
});

// ---------- local server for the VS Code extension ----------
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204).end();
      let ev; try { ev = JSON.parse(body); } catch { return; }
      onEditorEvent(ev);
    });
  });
  server.on('error', e => console.error('[server]', e.message));
  server.listen(PORT, '127.0.0.1');
}

function onEditorEvent(ev) {
  const wasFocused = ctx.focused, prevFile = ctx.file;
  ctx.focused = !!ev.focused;
  if (ev.file !== undefined) {
    ctx.file = ev.file; ctx.workspace = ev.workspace || null; ctx.languageId = ev.languageId || null;
    if (ctx.workspace && ctx.workspace !== settings.lastWorkspace) { settings.lastWorkspace = ctx.workspace; saveSettings(); }
  }
  if (pendingFind && ctx.file && ctx.file !== prevFile) { clearTimeout(findTimer); findTimer = setTimeout(checkFind, 1500); return; }
  if (busy) return;
  if (ev.type === 'explain') { sendState('sorpresa'); setTimeout(explainCurrent, 400); return; }
  if (ev.type === 'tour') { startTour(); return; }
  if (tour) return;                                    // during the tour we open files ourselves
  if (ctx.focused) maybeOfferTour();
  // entered VS Code, or switched file inside it → he comes closer to have a look
  if ((ctx.focused && !wasFocused) || (ctx.focused && ctx.file && ctx.file !== prevFile)) sendState('curioso', 'reposo', 1800);
}

// ---------- dragging (moves the chat too) ----------
ipcMain.on('set-ignore', (_e, ignore) => {
  if (win && !dragTimer) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('drag-start', () => {
  if (!win || dragTimer) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  const off = { x: c.x - wx, y: c.y - wy };
  win.setIgnoreMouseEvents(false);
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    // setBounds with a fixed size avoids the Windows DPI bug where moving a transparent window slowly grows it
    win.setBounds({ x: p.x - off.x, y: p.y - off.y, width: SIZE, height: SIZE });
    placeBubble();
  }, 16);
});

ipcMain.on('drag-end', () => {
  clearInterval(dragTimer); dragTimer = null;
  savePosition();
});

// ---------- right-click menu ----------
ipcMain.on('menu', () => {
  const send = s => () => sendState(s, s === 'dormir' ? null : 'reposo', 2800);
  Menu.buildFromTemplate([
    { label: 'Charlar con Obsi-boty', click: () => openPanel({ focus: true }) },
    { label: 'Tour del proyecto', enabled: !busy, click: () => startTour() },
    { label: 'Rehacer el tour (si el proyecto cambió)', enabled: !busy, click: () => startTour({ fresh: true }) },
    { label: ctx.file ? `Explicar ${path.basename(ctx.file)}` : 'Explicar (abre un archivo en VS Code)', enabled: !!ctx.file && !busy, click: explainCurrent },
    { label: 'Hazme una pregunta de examen', enabled: !busy, click: () => chat(QUIZ_PROMPT) },
    { label: 'Reto: pídeme que te muestre un archivo', enabled: !busy, click: () => chat(FIND_PROMPT) },
    { label: 'Preguntas sorpresa', type: 'checkbox', checked: settings.quiz, click: i => { settings.quiz = i.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Saludar', click: send('saludar') },
    { label: 'Celebrar', click: send('celebrar') },
    { label: 'Dormir', click: send('dormir') },
    { type: 'separator' },
    { label: 'Tamaño', submenu: Object.keys(SIZES).map(k => ({
        label: SIZE_LABELS[k], type: 'radio', checked: k === sizeKey, click: () => setSize(k),
      })) },
    { label: 'Volver a la esquina', click: () => {
        const wa = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: wa.x + wa.width - SIZE - 16, y: wa.y + wa.height - SIZE - 8, width: SIZE, height: SIZE });
        placeBubble(); savePosition();
      } },
    { type: 'separator' },
    { label: 'Salir de Obsi-boty', click: () => app.quit() },
  ]).popup({ window: win });
});

app.whenReady().then(() => {
  loadSettings();
  brain.initCache(app.getPath('userData'));
  brain.initTours(app.getPath('userData'));
  createWindow();
  startServer();
});
app.on('second-instance', () => sendState('saludar', 'reposo', 2800));
app.on('before-quit', () => { clearInterval(cursorTimer); clearInterval(dragTimer); clearInterval(quizTimer); brain.cancel(); });
app.on('window-all-closed', () => app.quit());
