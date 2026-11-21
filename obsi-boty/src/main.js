// Obsi-boty — main process
// - A small transparent, frameless, always-on-top window hosts the 3D robot (click-through except on the robot).
// - A local HTTP server (127.0.0.1:47321) receives events from the VS Code extension: which file is open, focus.
// - A chat bubble window next to the robot: explanations, free questions, "show me the file that...", quiz mode.
// - The "brain" (brain.js) talks to Claude Code in headless mode, read-only, inside the project folder.

const { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const brain = require('./cerebro/brain');
const studyPack = require('./cerebro/pack');
const voiceModel = require('./voz/modelo');

// online = Claude Code is available. Without it (free plan) Obsi-boty runs in "study mode" from the study pack.
let online = true;

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
let settings = { lastWorkspace: null, quiz: true, toursOffered: {}, speak: true, voiceName: 'Raul', autostart: false, listen: false };
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
const BUBBLE_W = 420;            // glass panel (~360) + the strip on the robot's side where the energy arc is drawn
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
  let x = b.x - BUBBLE_W + overlap, side = 'left';       // prefer the left side of the robot
  if (x < wa.x) { x = b.x + b.width - overlap; side = 'right'; }   // no room: right side
  if (side !== bubbleSide) { bubbleSide = side; bubble.webContents.send('side', side); }   // arc + border glow point at him
  let y = Math.round(b.y + b.height*0.55 - bubbleHeight);  // bottom of the chat near the robot's middle
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - bubbleHeight - 4));
  bubble.setBounds({ x: Math.round(x), y, width: BUBBLE_W, height: bubbleHeight });
}
let bubbleSide = null;
const sendContext = () => bubble && !bubble.isDestroyed() && bubble.webContents.send('context', ctx.file ? path.basename(ctx.file) : null);

function openPanel({ focus = false } = {}) {
  if (!bubble) return;
  bubbleOpen = true;
  bubble.webContents.send('open', { focus });
  sendContext();
  placeBubble();
  if (focus) { bubble.show(); bubble.focus(); }
  else if (!bubble.isVisible()) bubble.showInactive();
}
function hidePanel() {
  bubbleOpen = false;
  if (bubble && bubble.isVisible()) bubble.hide();
}
const dbg = s => { if (process.env.OBSI_DEBUG) try { fs.appendFileSync(process.env.OBSI_DEBUG, `· ${s}\n`); } catch { /* debug only */ } };
const post = m => {
  // OBSI_DEBUG=<file>: append every chat message to that file (Electron's console isn't visible on Windows)
  if (process.env.OBSI_DEBUG) try { fs.appendFileSync(process.env.OBSI_DEBUG, `[${m.role}] ${m.tag ? `[${m.tag}] ` : ''}${String(m.text || '').replace(/\s+/g, ' ').slice(0, 170)}${m.actions ? ' | ' + m.actions.map(a => a.label).join(' / ') : ''}\n`); } catch { /* debug only */ }
  if (bubble) bubble.webContents.send('message', m);
  if (m.role === 'bot' && settings.speak && !m.silent) say(m.text);
};

// ---------- voice out (Windows voices, offline; spoken from the bubble page) ----------
function say(text) { if (bubble && text) bubble.webContents.send('speak', { text, voice: settings.voiceName }); }
function shutUp() { if (bubble) bubble.webContents.send('stop-speaking'); }
ipcMain.on('speaking', (_e, on) => {
  dbg(`speaking ${on}`);
  if (win && !win.isDestroyed()) win.webContents.send('talking', on);
  earSend('ear-mute', on);                                  // don't hear himself
  // mock defense: once he finishes asking, listen for your spoken answer
  if (!on && sim && sim.waiting && earReady) setEarMode('dictate', listenAfter());
});

// ---------- voice in (Vosk, offline, in a hidden window) ----------
let ear = null, earReady = false, earStarting = null;
const earSend = (ch, data) => { if (ear && !ear.isDestroyed()) ear.webContents.send(ch, data); };
const listenAfter = () => settings.listen ? 'wake' : 'off';
function setEarMode(mode, after = listenAfter()) { earSend('ear-mode', { mode, after }); }

// make sure the model exists and the ear window is loaded; resolves when it's ready to listen
function ensureEar() {
  if (earReady) return Promise.resolve();
  if (earStarting) return earStarting;
  earStarting = (async () => {
    if (!voiceModel.exists()) {
      openPanel();
      post({ role: 'bot', kind: 'hint', silent: true, text: 'Primera vez: voy a descargar mi oído en español (unos 40 MB, del sitio oficial de Vosk). Solo pasa una vez.' });
      await voiceModel.ensure(m => loading(m));
      loading(null);
    }
    await new Promise((resolve, reject) => {
      ear = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true, focusable: false,
        webPreferences: { preload: path.join(__dirname, 'voz', 'oido-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      ear.loadFile(path.join(__dirname, 'voz', 'oido.html'));
      ear.webContents.on('console-message', (_e, level, message) => { if (level >= 2) dbg('[oido] ' + message); });
      const t = setTimeout(() => reject(new Error('el modelo de voz tardó demasiado en cargar')), 60000);
      earStartWait = { resolve: () => { clearTimeout(t); resolve(); }, reject: e => { clearTimeout(t); reject(e); } };
    });
    earReady = true;
  })().catch(e => {
    earStarting = null; loading(null);
    if (ear && !ear.isDestroyed()) ear.destroy(); ear = null;
    post({ role: 'bot', kind: 'error', text: `No pude activar el oído: ${e.message}` });
    throw e;
  });
  return earStarting;
}
let earStartWait = null, testAudio = null;

ipcMain.on('ear', (_e, { type, data }) => {
  dbg(`ear ${type} ${data || ''}`);
  if (type === 'ready') { if (earStartWait) earStartWait.resolve(); return; }
  if (type === 'error') { if (earStartWait && !earReady) earStartWait.reject(new Error(data)); else post({ role: 'bot', kind: 'error', text: data }); return; }
  // standby (robot hidden): any wake phrase brings him back
  if (!win) { if (type === 'wake' || type === 'command') appear(); return; }
  if (type === 'wake') { shutUp(); sendState('escuchar', 'reposo', 8000); openPanel(); bubble.webContents.send('listening', true); return; }
  if (type === 'partial') { bubble.webContents.send('partial', data); return; }
  if (type === 'timeout') { bubble.webContents.send('listening', false); sendState('reposo'); return; }
  if (type === 'command' || type === 'dictation') { bubble.webContents.send('listening', false); voiceCommand(String(data)); }
});

// what you said → a local shortcut when it's obvious (instant), otherwise the normal chat
function voiceCommand(text) {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (sim && sim.waiting) return chat(text);                                   // spoken answer in the mock defense
  if (/\b(callate|silencio|deja de hablar|basta)\b/.test(t)) { shutUp(); return; }
  if (/\b(ya terminamos|hasta luego|nos vemos|adios|escondete|ocultate)\b/.test(t)) return hideToStandby();
  if (/^a trabajar\b/.test(t)) { sendState('saludar', 'reposo', 2500); openPanel(); return post({ role: 'bot', text: '¡Aquí estoy! ¿En qué trabajamos?' }); }
  if (/\b(duermete|a dormir|descansa)\b/.test(t)) { shutUp(); sendState('dormir'); return; }
  if (/\b(simulacro|defensa)\b/.test(t)) return startSim();
  if (/\btour\b|\brecorrido\b/.test(t)) return startTour();
  if (/\bexplica(me)?\b.*\b(este|el|ese) archivo\b|\bque hace este archivo\b/.test(t)) { openPanel(); return explainCurrent(); }
  if (/\b(siguiente|continua|adelante)\b/.test(t) && tour) return showTourStep(tour.i + 1);
  if (/\b(anterior|atras|regresa)\b/.test(t) && tour) return showTourStep(tour.i - 1);
  if (/\bpregunta(me)?\b|\bexamen\b/.test(t) && t.split(' ').length <= 6) return chat(QUIZ_PROMPT);
  if (/\breto\b/.test(t)) return chat(FIND_PROMPT);
  if (/^(hola|que tal|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(t) && t.split(' ').length <= 4) {
    sendState('saludar', 'reposo', 2500); openPanel(); return post({ role: 'bot', text: '¡Hola, Josué! ¿En qué te ayudo? Puedo explicarte un archivo, darte el tour o hacerte un simulacro de defensa.' });
  }
  chat(text);
}

// push-to-talk: mic button in the chat, Ctrl+Alt+Espacio, or "listen-now" from anywhere
async function listenNow() {
  try { await ensureEar(); } catch { return; }
  shutUp(); sendState('escuchar', 'reposo', 8000); openPanel();
  bubble.webContents.send('listening', true);
  setEarMode(sim && sim.waiting ? 'dictate' : 'command');
}
ipcMain.on('listen-now', listenNow);

async function setListen(on) {
  settings.listen = !!on; saveSettings();
  if (!on) { setEarMode('off', 'off'); return; }
  try { await ensureEar(); } catch { settings.listen = false; saveSettings(); return; }
  setEarMode('wake', 'wake');
  sendState('saludar', 'reposo', 2500);
  say('Listo. Cuando me necesites, di: oye Obsi.');
}
const loading = t => bubble && bubble.webContents.send('loading', t);

ipcMain.on('bubble-height', (_e, h) => { bubbleHeight = Math.max(80, Math.min(Math.ceil(h), 520)); placeBubble(); });
ipcMain.on('bubble-close', () => {
  hidePanel(); shutUp(); endSim(true);
  if (busy) { brain.cancel(); busy = false; }
  sendState('reposo');
});
ipcMain.on('chat-reset', () => {
  brain.newConversation(); busy = false; endFind(); shutUp(); endSim(true);
  bubble.webContents.send('reset');
  sendState('reposo');
});
ipcMain.on('open-file', (_e, { file, line }) => openInVSCode(file, line));
ipcMain.on('chat-send', (_e, text) => chat(text));
ipcMain.on('chat-action', (_e, value) => handleAction(value));
function handleAction(value) {
  if (value === 'sim-start') startSim();
  else if (value === 'sim-skip') answerSim(null);
  else if (value === 'sim-next') askSimQuestion();
  else if (value === 'sim-stop') endSim();
  else if (value.startsWith('simgrade-')) recordSim(value.slice(9));
  else if (value === 'quiz-yes') chat(QUIZ_PROMPT);
  else if (value === 'find-start') chat(FIND_PROMPT);
  else if (value === 'find-hint') chat('Dame una pista para encontrar el archivo del reto, sin decirme su nombre ni su ruta.');
  else if (value === 'quiz-reveal') offlineReveal(null);
  else if (value.startsWith('grade-')) {
    const g = value.slice(6);
    react({ grade: g });
    post({ role: 'bot', grade: g, text: { correcto: '¡Bien! 🎉', parcial: 'Casi. Repasa los archivos y la próxima sale. 💪', incorrecto: 'No pasa nada: para eso practicamos. 📚' }[g], actions: [{ label: 'Otra pregunta', value: 'quiz-yes' }] });
  }
  else if (value === 'find-giveup') giveUpFind();
  else if (value === 'explain-it') explainCurrent();
  else if (value === 'tour-start') startTour();
  else if (value === 'tour-restart') startTour();
  else if (value === 'tour-next') showTourStep(tour ? tour.i + 1 : 0);
  else if (value === 'tour-prev') showTourStep(tour ? tour.i - 1 : 0);
  else if (value === 'tour-end') { tour = null; post({ role: 'bot', kind: 'hint', text: 'Va. Cuando quieras el tour, búscalo en mi menú (clic derecho → Tour del proyecto).' }); sendState('reposo'); }
  else if (value === 'quiz-no') { hidePanel(); sendState('reposo'); }
  else if (value === 'quiz-off') { settings.quiz = false; saveSettings(); post({ role: 'bot', kind: 'hint', text: 'Listo, ya no te haré preguntas sorpresa. Puedes activarlas otra vez desde mi menú (clic derecho).' }); }
}

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
  if (sim && sim.waiting) return answerSim(text);
  if (!online) return offlineChat(text);
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
    if (busy && switchToStudyMode(e)) { busy = false; loading(null); return offlineChat(text); }
    if (busy && e.code !== 'CANCELLED') failMessage(e);
  } finally { busy = false; loading(null); }
}

// Claude Code installed but not usable (no paid plan / not logged in) and there is a study pack → study mode
function switchToStudyMode(e) {
  if (e.code !== 'LOGIN' || !getPack()) return false;
  online = false;
  post({ role: 'bot', kind: 'hint', text: 'Claude Code no está disponible, así que me cambio a modo estudio (uso el paquete que preparó Josué).' });
  return true;
}

async function explainCurrent() {
  if (!ctx.file) { sendState('escuchar', 'reposo', 6000); openPanel({ focus: true }); return; }
  if (busy) return;
  if (!online) return offlineExplain(ctx.file);
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
    if (busy && switchToStudyMode(e)) { clearTimeout(thinkTimer); busy = false; loading(null); return offlineExplain(file, { quiet: true }); }
    if (busy && e.code !== 'CANCELLED') failMessage(e);
  } finally { clearTimeout(thinkTimer); busy = false; loading(null); }
}

// ---------- study mode (no Claude Code: everything comes from the study pack) ----------
let packCache = { ws: null, data: null };
function getPack() {
  const ws = workspace();
  if (!ws) return null;
  if (packCache.ws !== ws) packCache = { ws, data: studyPack.load(ws) };
  return packCache.data;
}
const absOf = r => path.join(workspace(), r);
const relKey = f => path.relative(workspace(), f).replace(/\\/g, '/');
// `paths` in a pack text → clickable files
function refsIn(text) {
  const files = {};
  for (const m of String(text).matchAll(/`([^`\n]+)`/g)) {
    const p = m[1].replace(/:\d+(-\d+)?$/, '');
    try { if (fs.statSync(absOf(p)).isFile()) files[m[1]] = { file: absOf(p), line: null }; } catch { /* not a file */ }
  }
  return files;
}
const STUDY_ACTIONS = [{ label: 'Tour del proyecto', value: 'tour-start' }, { label: 'Pregunta de examen', value: 'quiz-yes' }, { label: 'Reto: muéstrame', value: 'find-start' }];
let pendingQuiz = null, findHints = [], findHintIdx = 0;
const askedQuestions = new Set(), askedChallenges = new Set();

function noPack() {
  sendState('confundido', 'reposo', 4000);
  post({ role: 'bot', kind: 'hint', text: `No tengo Claude Code ni paquete de estudio para ${path.basename(workspace())}. Pídele a Josué que lo genere y luego haz "git pull" en la carpeta de Obsi-boty.` });
}
const pickUnused = (list, used) => {
  if (used.size >= list.length) used.clear();
  const free = list.map((_, i) => i).filter(i => !used.has(i));
  const i = free[Math.floor(Math.random()*free.length)]; used.add(i); return list[i];
};

function offlineExplain(file, { quiet = false } = {}) {
  const p = getPack(); openPanel();
  if (!quiet) post({ role: 'user', text: `Explícame ${path.basename(file)}` });
  if (!p) return noPack();
  const text = p.explanations[relKey(file)];
  if (text) { post({ role: 'bot', tag: `paquete de estudio · ${path.basename(file)}`, text, files: refsIn(text) }); sendState('explicar', 'reposo', 9000); return; }
  const some = Object.keys(p.explanations).slice(0, 5).map(r => `- \`${r}\``).join('\n');
  sendState('confundido', 'reposo', 3000);
  post({ role: 'bot', text: `Este archivo no está en mi paquete de estudio (tengo los ${Object.keys(p.explanations).length} más importantes). Prueba con alguno de estos:\n${some}`, files: refsIn(some) });
}

function offlineQuiz() {
  const p = getPack(); if (!p) return noPack();
  if (!p.questions.length) return post({ role: 'bot', kind: 'hint', text: 'Mi paquete no trae preguntas.' });
  pendingQuiz = pickUnused(p.questions, askedQuestions);
  sendState('pregunta', 'reposo', 8000);
  post({ role: 'bot', tag: 'Pregunta de examen', text: `${pendingQuiz.q}\n\nEscribe tu respuesta y te muestro la correcta para que te califiques.`,
    actions: [{ label: 'Ver la respuesta', value: 'quiz-reveal' }] });
}

function offlineReveal(userAnswer) {
  const q = pendingQuiz; pendingQuiz = null;
  if (!q) return;
  const files = q.files.map(r => `\`${r}\``).join(', ');
  const text = `${userAnswer ? 'Esta es la respuesta esperada, compárala con la tuya:' : 'La respuesta:'}\n\n${q.answer}${files ? `\n\nRepasa: ${files}` : ''}`;
  sendState('explicar', 'reposo', 6000);
  post({ role: 'bot', text, files: refsIn(text), actions: userAnswer
    ? [{ label: '✔ Acerté', value: 'grade-correcto' }, { label: '≈ Casi', value: 'grade-parcial' }, { label: '✘ Fallé', value: 'grade-incorrecto' }]
    : [{ label: 'Otra pregunta', value: 'quiz-yes' }] });
}

function offlineFind() {
  const p = getPack(); if (!p) return noPack();
  if (!p.challenges.length) return post({ role: 'bot', kind: 'hint', text: 'Mi paquete no trae retos.' });
  const c = pickUnused(p.challenges, askedChallenges);
  startFind(absOf(c.file)); findHints = c.hints || []; findHintIdx = 0;
  sendState('pregunta', 'reposo', 8000);
  post({ role: 'bot', tag: 'Reto: muéstrame', text: `${c.prompt}\n\nÁbrelo en VS Code y yo te digo si es ese.`, actions: FIND_ACTIONS });
}

function offlineHint() {
  if (!pendingFind) return;
  const h = findHints[findHintIdx++];
  post({ role: 'bot', text: h ? `Pista ${findHintIdx}: ${h}` : 'Ya no tengo más pistas. 😅 ¿Te rindes?', actions: FIND_ACTIONS });
  sendState('explicar', 'reposo', 4000);
}

function offlineChat(text) {
  const p = getPack(); if (!p) return noPack();
  if (text === QUIZ_PROMPT) return offlineQuiz();
  if (text === FIND_PROMPT) return offlineFind();
  if (text.startsWith('Dame una pista')) return offlineHint();
  if (pendingQuiz) return offlineReveal(text);
  const hits = studyPack.search(p, text);
  if (!hits.length) {
    sendState('confundido', 'reposo', 3000);
    return post({ role: 'bot', text: 'Sin Claude Code no puedo charlar de cualquier cosa, y no encontré nada parecido en mi paquete. 🙈 Pero puedo hacer esto contigo:', actions: STUDY_ACTIONS });
  }
  const lines = hits.map(h => `- \`${h.rel}\`: ${String(p.explanations[h.rel]).split(/(?<=\.)\s/)[0]}`).join('\n');
  const reply = `En modo estudio no charlo libremente, pero en mi paquete encontré esto:\n${lines}`;
  post({ role: 'bot', text: reply, files: refsIn(reply), actions: STUDY_ACTIONS });
  sendState('explicar', 'reposo', 6000);
  if (/mu[eé]strame|ens[eé]ñame|abre|d[oó]nde/i.test(text) && hits[0].score >= 3) openInVSCode(absOf(hits[0].rel));
}

function tourFromPack() {
  const p = getPack(); if (!p || !p.tour) return null;
  const steps = p.tour.steps.map(s => ({ ...s, abs: absOf(s.rel) })).filter(s => fs.existsSync(s.abs));
  return { intro: p.tour.intro, flow: p.tour.flow, steps };
}

// generate the study pack (only where Claude Code works)
async function generatePack() {
  if (busy || !workspace()) return;
  busy = true; openPanel();
  post({ role: 'user', text: 'Genera el paquete de estudio' });
  sendState('escanear');
  post({ role: 'bot', kind: 'hint', text: 'Voy a preparar el paquete para tus compañeros: tour, explicaciones, preguntas y retos. Tarda varios minutos; puedes seguir trabajando.' });
  try {
    const { pack, file } = await studyPack.generate(workspace(), m => loading(m));
    packCache = { ws: null, data: null };
    sendState('celebrar', 'reposo', 4000);
    post({ role: 'bot', text: `¡Paquete listo! ${Object.keys(pack.explanations).length} explicaciones, ${pack.questions.length} preguntas, ${pack.challenges.length} retos y ${pack.tour.steps.length} paradas.\n\nSe guardó en \`${path.relative(path.join(__dirname, '..', '..'), file).replace(/\\/g, '/')}\`. Haz commit y push para que tu equipo lo tenga con "git pull".` });
  } catch (e) { failMessage(e); }
  finally { busy = false; loading(null); }
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

// ---------- mock oral defense ("simulacro de defensa oral") ----------
// 5 questions from the study pack, asked out loud like the jury would. Online: Claude grades your answer
// against the verified reference answer. Study mode: you see the reference answer and grade yourself.
let sim = null;            // { total, i, scores:[], q, waiting }
const SIM_POINTS = { correcto: 1, parcial: 0.5, incorrecto: 0 };

function startSim() {
  if (busy) return;
  endFind(); tour = null; pendingQuiz = null;
  openPanel({ focus: true });
  post({ role: 'user', text: 'Simulacro de defensa oral' });
  const p = getPack();
  if (!p || !p.questions || !p.questions.length) {
    return post({ role: 'bot', kind: 'hint', text: online
      ? 'Para el simulacro necesito el paquete de estudio de este proyecto. Genéralo desde mi menú (clic derecho → Generar paquete de estudio).'
      : 'No tengo paquete de estudio para este proyecto. Pídele a Josué que lo genere y haz "git pull".' });
  }
  sim = { total: Math.min(5, p.questions.length), i: 0, scores: [], q: null, waiting: false };
  sendState('saludar', 'reposo', 2500);
  post({ role: 'bot', tag: 'Simulacro de defensa oral', text: `Te haré ${sim.total} preguntas como el jurado. Respóndeme como si se lo explicaras a un profesor: con tus palabras, mencionando archivos y decisiones. ${online ? 'Yo te califico.' : 'Al final de cada una te muestro la respuesta y te calificas.'}`,
    actions: [{ label: '▶ Empezar', value: 'sim-next' }, { label: 'Ahora no', value: 'sim-stop' }] });
}

const simNextActions = () => sim.i >= sim.total
  ? [{ label: 'Ver mi calificación', value: 'sim-next' }]
  : [{ label: 'Siguiente pregunta ▶', value: 'sim-next' }, { label: 'Terminar aquí', value: 'sim-stop' }];

function askSimQuestion() {
  if (!sim || busy) return;
  if (sim.i >= sim.total) return finishSim();
  sim.q = pickUnused(getPack().questions, askedQuestions);
  sim.i++; sim.waiting = true;
  sendState('pregunta', 'reposo', 8000);
  post({ role: 'bot', tag: `Pregunta ${sim.i} de ${sim.total}`, text: sim.q.q, actions: [{ label: 'No sé, dime la respuesta', value: 'sim-skip' }] });
}

async function answerSim(text) {
  if (!sim || !sim.waiting) return;
  const q = sim.q; sim.waiting = false;
  const refFiles = q.files.map(r => `\`${r}\``).join(', ');
  if (!text) {                                             // skipped
    post({ role: 'bot', text: `La respuesta:\n\n${q.answer}${refFiles ? `\n\nRepasa: ${refFiles}` : ''}`, files: refsIn(q.answer + refFiles), grade: 'incorrecto', actions: simNextActions() });
    sim.scores.push('incorrecto'); react({ grade: 'incorrecto' });
    return;
  }
  if (!online) {                                           // study mode: self-grading
    sendState('explicar', 'reposo', 6000);
    post({ role: 'bot', text: `Compárala con la respuesta de referencia:\n\n${q.answer}${refFiles ? `\n\nRepasa: ${refFiles}` : ''}`, files: refsIn(q.answer + refFiles),
      actions: [{ label: '✔ Acerté', value: 'simgrade-correcto' }, { label: '≈ Casi', value: 'simgrade-parcial' }, { label: '✘ Fallé', value: 'simgrade-incorrecto' }] });
    return;
  }
  busy = true; sendState('pensar'); loading('Calificando tu respuesta como lo haría el jurado');
  try {
    const res = await brain.ask({ workspace: workspace(), message: [
      'Simulacro de defensa oral del proyecto.',
      `Pregunta del jurado: "${q.q}"`,
      `Respuesta de referencia (ya verificada en el proyecto): ${q.answer}`,
      `Respuesta del estudiante: "${text}"`,
      'Califícala como un profesor exigente pero justo: qué estuvo bien, qué faltó o estuvo mal, y cómo la diría mejor en 2 o 3 frases. No repitas toda la referencia.',
      'Termina con una línea exacta: RESULTADO: correcto, RESULTADO: parcial o RESULTADO: incorrecto.',
    ].join('\n') });
    if (!sim) return;
    const g = res.grade || 'parcial';
    sim.scores.push(g);
    post({ role: 'bot', ...res, grade: g, actions: simNextActions() });
    react({ grade: g });
  } catch (e) {
    if (!sim) return;
    post({ role: 'bot', text: `No pude calificarla (${e.message}). Compárala tú con la referencia:\n\n${q.answer}`, files: refsIn(q.answer),
      actions: [{ label: '✔ Acerté', value: 'simgrade-correcto' }, { label: '≈ Casi', value: 'simgrade-parcial' }, { label: '✘ Fallé', value: 'simgrade-incorrecto' }] });
  } finally { busy = false; loading(null); }
}

function recordSim(g) {
  if (!sim || !SIM_POINTS.hasOwnProperty(g)) return;
  sim.scores.push(g); react({ grade: g });
  post({ role: 'bot', grade: g, silent: true, text: { correcto: '¡Bien!', parcial: 'Casi, va bien.', incorrecto: 'Anotada para repasar.' }[g], actions: simNextActions() });
}

function finishSim() {
  if (!sim) return;
  const n = sim.scores.length || 1;
  const score = Math.round(sim.scores.reduce((s, g) => s + SIM_POINTS[g], 0) / n * 100) / 10;
  const count = g => sim.scores.filter(x => x === g).length;
  const verdict = score >= 8 ? '¡Estás listo para la defensa! 🎓' : score >= 6 ? 'Vas bien, pero repasa las que fallaste.' : 'Hay que repasar más; haz el tour otra vez y vuelve a intentarlo. 💪';
  sendState(score >= 8 ? 'celebrar' : score >= 6 ? 'explicar' : 'ups', 'reposo', 4500);
  post({ role: 'bot', tag: 'Resultado del simulacro', text: `Calificación: **${score} de 10**\n\n- Correctas: ${count('correcto')}\n- A medias: ${count('parcial')}\n- Incorrectas: ${count('incorrecto')}\n\n${verdict}`,
    actions: [{ label: 'Otro simulacro', value: 'sim-start' }, { label: 'Tour del proyecto', value: 'tour-start' }] });
  sim = null;
}

function endSim(silent = false) {
  if (!sim) return;
  if (!silent && sim.scores.length) return finishSim();
  sim = null;
}

// ---------- standby ("modo guardia") ----------
// While hidden, Obsi-boty does NOT keep running: a tiny PowerShell listener (src/voz/guardia.ps1, ~110 MB, Windows'
// own recognizer) waits for "Obsi, a trabajar" / "Oye Obsi" and opens the app again with --despertar.
const GUARD_SCRIPT = path.join(__dirname, 'voz', 'guardia.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const guardArgs = () => ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', GUARD_SCRIPT];

function setAutostart(on) {
  settings.autostart = !!on; saveSettings();
  // at Windows login start only the guardian (not the whole app)
  app.setLoginItemSettings({ openAtLogin: !!on, path: POWERSHELL, args: guardArgs(), name: 'ObsiBotyGuardia' });
  if (on) say('Listo. Cuando prendas la computadora me quedaré esperando. Di: Obsi, a trabajar, y aparezco.');
}

// Created through WMI so it is fully independent: Electron takes its own child processes down when it quits.
function startGuardian() {
  const cmdline = `"${POWERSHELL}" ${guardArgs().map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}' } | Out-Null`;
  return new Promise(resolve => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    child.on('exit', resolve); child.on('error', resolve);
  });
}

function appear() {
  dbg(`appear (visible=${!!win})`);
  if (win) { sendState('saludar', 'reposo', 2500); return; }
  createWindow();
}

// greeting when the guardian woke us up
function greetOnWake() {
  win.webContents.once('did-finish-load', () => setTimeout(() => {
    sendState('saludar', 'reposo', 3000);
    say(['¡Listo, Josué! ¿En qué trabajamos hoy?', '¡A trabajar! ¿Qué hacemos?', 'Aquí estoy. ¿Le seguimos al proyecto?'][Math.floor(Math.random() * 3)]);
  }, 1200));
}

// "ya terminamos": say goodbye, leave the guardian listening, and close completely (frees all its memory)
function hideToStandby() {
  shutUp(); endSim(true); endFind(); tour = null;
  sendState('saludar');
  say('Va. Aquí estaré. Di: Obsi, a trabajar, cuando me necesites.');
  dbg('hidden: guardian');
  setTimeout(async () => { await startGuardian(); app.quit(); }, 3500);
}

// ---------- guided tour ----------
let tour = null;           // { intro, flow, steps:[{abs, rel, kind, line, endLine, title, text}], i }

async function startTour({ fresh = false } = {}) {
  if (busy) return;
  endFind();
  openPanel();
  post({ role: 'user', text: fresh ? 'Prepara el tour otra vez' : 'Dame un tour del proyecto' });
  if (!workspace()) { post({ role: 'bot', kind: 'hint', text: 'Primero abre un archivo de tu proyecto en VS Code, así sé cuál recorrer.' }); return; }
  if (!online) {
    const t = tourFromPack(); if (!t) return noPack();
    tour = { ...t, i: -1 };
    sendState('saludar', 'reposo', 2500);
    post({ role: 'bot', tag: `Tour · ${t.steps.length} paradas`, text: `${t.intro}\n\nVoy a ir abriendo cada parada en VS Code. Tú me dices cuándo avanzar.`,
      actions: [{ label: '▶ Empezar', value: 'tour-next' }, { label: 'Más tarde', value: 'tour-end' }] });
    return;
  }
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
  shutUp();
  if (sim) { openPanel({ focus: true }); return; }                         // during the mock defense a click just brings the chat back
  if (bubbleOpen && !busy) { hidePanel(); sendState('reposo'); return; }   // second click closes the chat
  if (busy) { openPanel(); return; }
  sendState('sorpresa');
  setTimeout(explainCurrent, 600);
});

// ---------- local server for the VS Code extension ----------
function startServer() {
  const server = http.createServer((req, res) => {
    if (process.env.OBSI_DEBUG && req.method === 'GET' && req.url.startsWith('/test-audio') && testAudio) {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(testAudio).on('error', () => res.destroy()).pipe(res); return;
    }
    // the ear window's Web Worker downloads the speech model from here (it can't read file:// URLs)
    if (req.method === 'GET' && req.url === '/modelo-voz.tar.gz' && voiceModel.exists()) {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(voiceModel.MODEL_FILE).on('error', () => res.destroy()).pipe(res); return;
    }
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
  dbg(`event ${ev.type} file=${ev.file} busy=${busy} online=${online}`);
  // debug only: simulate typing in the chat or pressing a chat button
  if (process.env.OBSI_DEBUG && ev.type === 'say') return chat(ev.text);
  if (process.env.OBSI_DEBUG && ev.type === 'act') return handleAction(ev.value);
  if (process.env.OBSI_DEBUG && ev.type === 'voice') return voiceCommand(ev.text);
  // debug only: run a wav file through the ear as if you had spoken it
  if (process.env.OBSI_DEBUG && ev.type === 'eartest') {
    testAudio = ev.wav;
    return ensureEar().then(() => earSend('ear-test', { url: `http://127.0.0.1:${PORT}/test-audio?${Date.now()}`, as: ev.as || 'wake' })).catch(() => {});
  }
  const wasFocused = ctx.focused, prevFile = ctx.file;
  ctx.focused = !!ev.focused;
  if (ev.file !== undefined) {
    ctx.file = ev.file; ctx.workspace = ev.workspace || null; ctx.languageId = ev.languageId || null;
    if (ctx.file !== prevFile) sendContext();
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
    ...(online ? [] : [{ label: 'Modo estudio (sin Claude Code)', enabled: false }, { type: 'separator' }]),
    { label: 'Charlar con Obsi-boty', click: () => openPanel({ focus: true }) },
    { label: 'Tour del proyecto', enabled: !busy, click: () => startTour() },
    ...(online ? [
      { label: 'Rehacer el tour (si el proyecto cambió)', enabled: !busy, click: () => startTour({ fresh: true }) },
      { label: 'Generar paquete de estudio (para el equipo)', enabled: !busy && !!workspace(), click: generatePack },
    ] : []),
    { label: ctx.file ? `Explicar ${path.basename(ctx.file)}` : 'Explicar (abre un archivo en VS Code)', enabled: !!ctx.file && !busy, click: explainCurrent },
    { label: 'Hazme una pregunta de examen', enabled: !busy, click: () => chat(QUIZ_PROMPT) },
    { label: 'Reto: pídeme que te muestre un archivo', enabled: !busy, click: () => chat(FIND_PROMPT) },
    { label: 'Simulacro de defensa oral', enabled: !busy, click: () => startSim() },
    { label: 'Preguntas sorpresa', type: 'checkbox', checked: settings.quiz, click: i => { settings.quiz = i.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Escuchar «Oye Obsi»', type: 'checkbox', checked: settings.listen, click: i => setListen(i.checked) },
    { label: 'Hablarle ahora (Ctrl+Alt+Espacio)', click: listenNow },
    { label: 'Hablar en voz alta', type: 'checkbox', checked: settings.speak, click: i => { settings.speak = i.checked; saveSettings(); if (!i.checked) shutUp(); } },
    { label: 'Voz', submenu: [['Raul', 'Raúl'], ['Sabina', 'Sabina']].map(([v, l]) => ({
        label: l, type: 'radio', checked: settings.voiceName === v,
        click: () => { settings.voiceName = v; saveSettings(); say(`Hola, ahora hablo con la voz de ${l}.`); },
      })) },
    { label: 'Esperarme al prender la compu («Obsi, a trabajar»)', type: 'checkbox', checked: settings.autostart, click: i => setAutostart(i.checked) },
    { label: 'Esconderme (sigo escuchando)', click: () => hideToStandby() },
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
  online = brain.hasClaude();
  dbg(`start online=${online} claude=${brain.findClaude()}`);
  brain.initCache(app.getPath('userData'));
  brain.initTours(app.getPath('userData'));
  startServer();
  globalShortcut.register('Control+Alt+Space', () => (win ? listenNow() : appear()));
  createWindow();
  if (process.argv.includes('--despertar')) greetOnWake();
  if (settings.listen && voiceModel.exists()) setTimeout(() => ensureEar().then(() => setEarMode('wake', 'wake')).catch(() => {}), 3000);
});
app.on('second-instance', () => (win ? sendState('saludar', 'reposo', 2800) : appear()));
app.on('before-quit', () => { clearInterval(cursorTimer); clearInterval(dragTimer); clearInterval(quizTimer); brain.cancel(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
