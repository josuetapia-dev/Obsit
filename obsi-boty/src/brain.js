// Obsi-boty's "brain": finds Claude Code on this computer and talks to it in headless mode (claude -p).
// - Read-only tools (Read, Grep, Glob), always run inside the project folder so it can use docs/ and ADRs.
// - Keeps one conversation (session) going with --resume, so follow-up questions have context.
// - Understands two markers in the answers: "ABRIR: path[:line]" (open a file) and "RESULTADO: ..." (quiz grade).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_FILE_BYTES = 60 * 1024;          // bigger files are truncated before sending
const TIMEOUT_MS = 180 * 1000;
const MODEL = process.env.OBSI_MODEL || 'sonnet';

const PERSONA = [
  'Eres Obsi-boty, el robot compañero del equipo Obsi (Josué, Andrey y Ángel). Vives en el escritorio de Josué y lo ayudas a entender y defender el proyecto de la carpeta actual.',
  'Personalidad: técnico, claro y con un toque bromista, sin exagerar.',
  'Responde siempre en español y breve (unas 120 palabras como máximo, salvo que te pidan detalle). Usa viñetas "- " para enumerar. No uses encabezados markdown ni tablas.',
  'Puedes leer el proyecto con Read, Grep y Glob; nunca lo modificas. Antes de responder sobre el proyecto, búscalo en el código y en docs/ (CLAUDE.md, ADRs, bitácora). No inventes: si no lo encuentras, dilo.',
  'Cuando menciones un archivo, escribe su ruta relativa a la carpeta del proyecto entre comillas invertidas, por ejemplo `api/app/Http/Controllers/Api/V1/AccesoController.php`.',
  'Si el usuario pide ver, mostrar o abrir un archivo (por ejemplo "muéstrame el controlador que...", "¿dónde se registra...?"), encuéntralo y termina tu respuesta con una línea exacta: ABRIR: ruta/relativa:línea (la línea es opcional). Solo una línea ABRIR por respuesta, y solo en ese caso.',
  'Modo examen: si te piden una pregunta, haz UNA sola pregunta concreta sobre el proyecto, como la haría un profesor en la presentación (qué hace tal archivo, por qué se decidió algo, dónde está algo), sin dar la respuesta, y espera.',
  'Reto "muéstrame": si te piden un reto de búsqueda, elige un archivo importante del proyecto y pídele al usuario que te lo muestre abriéndolo en VS Code. Descríbelo solo por lo que hace (por ejemplo "Muéstrame el controlador que bloquea la pantalla tras varios intentos fallidos"), sin decir su nombre, carpeta ni ruta. Termina con una línea exacta: BUSCAR: ruta/relativa/del/archivo. El usuario no verá esa línea. Si después te pide una pista, dásela sin revelar el nombre.',
  'Cuando el usuario responda una pregunta de examen, califícalo con amabilidad: qué estuvo bien, qué faltó y la respuesta correcta en 2 o 3 líneas citando el archivo. Termina con una línea exacta: RESULTADO: correcto, RESULTADO: parcial o RESULTADO: incorrecto.',
].join('\n');

// ---------- locate the claude executable ----------
function newestMatch(root, maxDepth) {
  let best = null;
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase() === 'claude.exe') {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  walk(root, 0);
  return best && best.p;
}

let cachedClaude;
function findClaude() {
  if (cachedClaude !== undefined) return cachedClaude;
  const candidates = [
    process.env.OBSI_CLAUDE,
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return (cachedClaude = c);
  const bundled = newestMatch(path.join(process.env.LOCALAPPDATA || '', 'Claude-Data'), 4);   // Claude desktop app
  return (cachedClaude = bundled || 'claude');
}

// ---------- explanation cache (per file + modification time) ----------
let cacheFile = null, cache = {};
function initCache(dir) {
  cacheFile = path.join(dir, 'explanations.json');
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }
}
function saveCache() { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* not critical */ } }

// ---------- running claude ----------
let running = null;
let sessionId = null;          // current conversation

function runClaude(prompt, { cwd, stdin = '', resume = true, keepSession = false, maxTurns = 12, timeout = TIMEOUT_MS }) {
  if (running) running.kill();
  const exe = findClaude();
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', MODEL,
    '--append-system-prompt', PERSONA,
    '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task',
    '--max-turns', String(maxTurns),
  ];
  if (resume && sessionId) args.push('--resume', sessionId);

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, shell: exe.endsWith('.cmd') });
    running = child;
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude tardó demasiado en responder.')); }, timeout);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`No pude ejecutar Claude Code (${e.code || e.message}).`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (running === child) running = null;
      if (code === null) return reject(Object.assign(new Error('cancelado'), { code: 'CANCELLED' }));
      let json;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); }
      catch { return reject(new Error(stderr.trim().slice(0, 200) || 'Claude respondió algo que no entendí.')); }
      if (json.is_error) {
        const msg = String(json.result || json.api_error_status || 'error desconocido');
        if (/log ?in/i.test(msg)) return reject(Object.assign(new Error('Claude Code no tiene sesión iniciada fuera de la app. Inicia sesión una vez con /login (instrucciones en obsi-boty/README.md).'), { code: 'LOGIN' }));
        if (resume && sessionId && /session|conversation/i.test(msg)) { sessionId = null; return resolve(runClaude(prompt, { cwd, stdin, resume: false, keepSession, maxTurns, timeout })); }
        return reject(new Error(msg.slice(0, 200)));
      }
      if (json.session_id && !keepSession) sessionId = json.session_id;
      resolve(String(json.result || '').trim());
    });
    child.stdin.end(stdin);
  });
}

// pull out the markers and the file paths mentioned in `backticks` that really exist
function parseAnswer(raw, cwd) {
  let open = null, grade = null, find = null;
  const text = raw.split(/\r?\n/).filter(line => {
    const f = line.match(/^\s*\**BUSCAR:\**\s*`?([^`]+?)`?\s*$/i);
    if (f) { if (!find) find = resolveRef(f[1], cwd); return false; }
    const a = line.match(/^\s*\**ABRIR:\**\s*`?([^`]+?)`?\s*$/i);
    if (a) { if (!open) open = resolveRef(a[1], cwd); return false; }
    const g = line.match(/^\s*\**RESULTADO:\**\s*(correcto|parcial|incorrecto)/i);
    if (g) { grade = g[1].toLowerCase(); return false; }
    return true;
  }).join('\n').trim();
  const files = {};
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const ref = resolveRef(m[1], cwd);
    if (ref) files[m[1]] = ref;
  }
  if (find) { open = null; for (const k of Object.keys(files)) if (samePath(files[k].file, find.file)) delete files[k]; }   // never reveal the answer
  return { text, open, grade, files, find };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function resolveRef(ref, cwd) {
  const m = ref.trim().match(/^(.+?)(?::(\d+))?$/);
  if (!m || !/[\\/.]/.test(m[1])) return null;
  const abs = path.isAbsolute(m[1]) ? m[1] : path.join(cwd, m[1]);
  try { if (fs.statSync(abs).isFile()) return { file: abs, line: m[2] ? Number(m[2]) : null }; } catch { /* not a file */ }
  return null;
}

// ---------- public API ----------
async function ask({ message, workspace }) {
  if (!workspace || !fs.existsSync(workspace)) throw new Error('No sé cuál es tu proyecto todavía: abre un archivo de él en VS Code.');
  const raw = await runClaude(message, { cwd: workspace });
  if (!raw) throw new Error('Claude no devolvió respuesta.');
  return parseAnswer(raw, workspace);
}

async function explain({ file, workspace }) {
  if (!file || !fs.existsSync(file)) throw new Error('No encuentro el archivo abierto.');
  const stat = fs.statSync(file);
  const cwd = workspace && fs.existsSync(workspace) ? workspace : path.dirname(file);
  const key = `${file}|${stat.mtimeMs}`;
  if (cache[key]) return { ...parseAnswer(cache[key], cwd), cached: true };

  const rel = path.relative(cwd, file).replace(/\\/g, '/');
  let content = fs.readFileSync(file), truncated = false;
  if (content.length > MAX_FILE_BYTES) { content = content.subarray(0, MAX_FILE_BYTES); truncated = true; }
  const prompt = [
    `Explica qué hace el archivo \`${rel}\` de este proyecto. Su contenido viene por la entrada estándar.`,
    'Formato: una frase corta de qué es y para qué sirve; luego de 2 a 4 viñetas con lo principal (métodos, rutas, componentes clave);',
    'y si en docs/ hay un ADR o documento que explique por qué se hizo así, una línea "Por qué: ..." citando el documento (búscalo rápido; si no hay nada claro, omítela).',
    'Máximo 110 palabras. No expliques línea por línea.',
  ].join('\n');
  const stdin = `// Archivo: ${rel}${truncated ? ' (recortado, es muy largo)' : ''}\n${content.toString('utf8')}`;
  const raw = await runClaude(prompt, { cwd, stdin });
  if (!raw) throw new Error('Claude no devolvió explicación.');
  cache[key] = raw; saveCache();
  return { ...parseAnswer(raw, cwd), cached: false };
}

// ---------- guided tour ----------
const TOUR_PROMPT = [
  'Prepara un tour guiado de este proyecto para un integrante del equipo que debe poder defenderlo ante los profesores.',
  'Revisa CLAUDE.md, docs/ (arquitectura, ADRs, módulos) y el código real.',
  'Elige entre 8 y 12 paradas: las carpetas y archivos que sí o sí debe conocer. Ordénalas siguiendo el flujo de la app',
  '(por ejemplo: visión general → app móvil: pantalla y servicio → API: ruta → controlador → servicio/modelo → base de datos → panel web), e incluye al menos 2 carpetas.',
  'Para archivos, indica las líneas más importantes (line y endLine) si aplica.',
  'Responde SOLO con un bloque ```json con este formato exacto, sin texto fuera del bloque:',
  '{"intro":"1-2 frases de bienvenida al tour","steps":[{"path":"ruta/relativa","line":null,"endLine":null,"title":"título corto","text":"2 a 4 frases: qué es, por qué importa y qué podría preguntar un profesor"}],"flow":"el flujo completo de la app en 4 a 7 pasos, uno por línea, empezando cada línea con \\"- \\" y usando →"}',
  'Usa rutas relativas reales y verifica que existan.',
].join('\n');

let toursFile = null, tours = {};
function initTours(dir) {
  toursFile = path.join(dir, 'tours.json');
  try { tours = JSON.parse(fs.readFileSync(toursFile, 'utf8')); } catch { tours = {}; }
}

// one automatic retry: the model occasionally wraps the JSON badly
async function makeTour(workspace, opts = {}) {
  try { return await makeTourOnce(workspace, opts); }
  catch (e) { if (!e.raw) throw e; return makeTourOnce(workspace, { ...opts, fresh: true }); }
}

async function makeTourOnce(workspace, { fresh = false } = {}) {
  if (!workspace || !fs.existsSync(workspace)) throw new Error('No sé cuál es tu proyecto todavía: abre un archivo de él en VS Code.');
  const key = path.resolve(workspace).toLowerCase();
  if (!fresh && tours[key]) return { ...tours[key], cached: true };
  const raw = await runClaude(TOUR_PROMPT, { cwd: workspace, resume: false, keepSession: true, maxTurns: 40, timeout: 420 * 1000 });
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  let data;
  try { data = JSON.parse(m[1]); } catch { throw Object.assign(new Error('No pude armar el tour (la respuesta no vino en el formato esperado). Inténtalo otra vez.'), { raw }); }
  const steps = (data.steps || []).map(s => {
    const abs = path.join(workspace, String(s.path || ''));
    let kind = null; try { kind = fs.statSync(abs).isDirectory() ? 'folder' : 'file'; } catch { /* missing: dropped below */ }
    return kind && { abs, rel: String(s.path).replace(/\\/g, '/'), kind, line: Number(s.line) || null, endLine: Number(s.endLine) || null, title: String(s.title || s.path), text: String(s.text || '') };
  }).filter(Boolean);
  if (steps.length < 3) throw new Error('El tour salió muy corto. Inténtalo otra vez.');
  const tour = { intro: String(data.intro || ''), flow: String(data.flow || ''), steps };
  tours[key] = tour;
  try { fs.writeFileSync(toursFile, JSON.stringify(tours)); } catch { /* not critical */ }
  return { ...tour, cached: false };
}

function cancel() { if (running) { running.kill(); running = null; } }
function newConversation() { cancel(); sessionId = null; }

module.exports = { ask, explain, makeTour, initTours, cancel, newConversation, findClaude, initCache, samePath };
