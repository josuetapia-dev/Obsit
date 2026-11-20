// Study pack ("paquete de estudio"): everything Obsi-boty needs to work WITHOUT Claude Code.
// Generated once with Claude on a machine that has it, saved as obsi-boty/paquetes/<project folder>.json,
// committed to the repo, and used by teammates who only have the free plan.
//
// Contents (all paths relative to the project folder, so it works wherever the project is cloned):
//   tour         { intro, flow, steps:[{ rel, kind, line, endLine, title, text }] }
//   explanations { "<rel path>": "short explanation" }
//   questions    [{ q, answer, files:[rel] }]          → quiz with model answer + self-grading
//   challenges   [{ prompt, file, hints:[h1, h2] }]    → "show me" challenges

const fs = require('fs');
const path = require('path');
const brain = require('./brain');

const PACKS_DIR = path.join(__dirname, '..', 'paquetes');
const packFile = workspace => path.join(PACKS_DIR, `${path.basename(path.resolve(workspace))}.json`);

function load(workspace) {
  if (!workspace) return null;
  try { return JSON.parse(fs.readFileSync(packFile(workspace), 'utf8')); } catch { return null; }
}

const exists = (ws, rel) => { try { return fs.statSync(path.join(ws, rel)); } catch { return null; } };
const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i*n, i*n + n));

async function pool(items, size, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const EXPLAIN_FORMAT = 'una frase corta de qué es y para qué sirve; luego de 2 a 4 viñetas "- " con lo principal; y si en docs/ hay un ADR o documento que explique por qué se hizo así, una línea "Por qué: ..." citando el documento. Máximo 110 palabras por archivo, en español.';

async function generate(workspace, onProgress = () => {}) {
  const ws = path.resolve(workspace);
  const say = msg => onProgress(msg);

  say('1/4 · Tour del proyecto');
  const tour = await brain.makeTour(ws);

  say('2/4 · Eligiendo los archivos más importantes');
  const picked = await brain.askJSON([
    'Lista los 30 archivos del proyecto que un integrante del equipo sí o sí debe saber explicar ante los profesores',
    '(controladores, servicios, modelos, rutas, migraciones clave, páginas y servicios de la app, configuración importante). Revisa CLAUDE.md y docs/.',
    'Responde SOLO con un bloque ```json con un arreglo de rutas relativas reales, por ejemplo ["api/routes/api.php", "..."].',
  ].join('\n'), ws);
  const tourFiles = tour.steps.filter(s => s.kind === 'file').map(s => s.rel);
  const files = [...new Set([...tourFiles, ...(Array.isArray(picked) ? picked : []).map(norm)])]
    .filter(rel => { const st = exists(ws, rel); return st && st.isFile(); });

  say(`3/4 · Explicando ${files.length} archivos y preparando preguntas y retos (varios minutos)`);
  let done = 0;
  const explainJob = pool(chunks(files, 6), 3, async batch => {
    const res = await brain.askJSON([
      'Lee cada uno de estos archivos del proyecto y explica qué hace. Formato de cada explicación: ' + EXPLAIN_FORMAT,
      'Cuando menciones otro archivo, escribe su ruta relativa entre comillas invertidas.',
      'Archivos:', ...batch.map(f => `- ${f}`),
      'Responde SOLO con un bloque ```json con un objeto { "ruta/relativa": "explicación" } que tenga exactamente esas rutas como claves.',
    ].join('\n'), ws);
    done += batch.length; say(`3/4 · Explicaciones: ${done} de ${files.length}`);
    return res;
  });
  const questionsJob = brain.askJSON([
    'Prepara 25 preguntas de examen sobre este proyecto, como las haría un profesor en la presentación final.',
    'Varía el tipo: qué hace un archivo o módulo, por qué se tomó una decisión (ADRs), dónde está algo, cómo fluye un dato, qué pasa en un caso límite, patrones (Repository, Observer), seguridad y modo sin conexión.',
    'Cada respuesta: 2 a 4 frases correctas y verificadas en el código o en docs/, citando rutas relativas entre comillas invertidas.',
    'Responde SOLO con un bloque ```json: [{"pregunta":"...","respuesta":"...","archivos":["ruta/relativa"]}]',
  ].join('\n'), ws);
  const challengesJob = brain.askJSON([
    'Prepara 15 retos "muéstrame" para practicar encontrar archivos en este proyecto.',
    'Cada reto describe un archivo importante SOLO por lo que hace, sin decir su nombre, carpeta ni ruta (ej. "Muéstrame el controlador que bloquea el equipo tras varios PIN incorrectos").',
    'Incluye dos pistas: la primera vaga (zona del proyecto), la segunda más clara (sin decir el nombre exacto).',
    'Responde SOLO con un bloque ```json: [{"reto":"...","archivo":"ruta/relativa","pistas":["...","..."]}]',
  ].join('\n'), ws);

  const [explained, questions, challenges] = await Promise.all([explainJob, questionsJob, challengesJob]);

  say('4/4 · Revisando y guardando');
  const explanations = {};
  for (const obj of explained) for (const [k, v] of Object.entries(obj || {})) {
    const rel = norm(k); if (files.includes(rel) && String(v).trim()) explanations[rel] = String(v).trim();
  }
  const pack = {
    project: path.basename(ws),
    generatedAt: new Date().toISOString(),
    tour: { intro: tour.intro, flow: tour.flow, steps: tour.steps.map(({ rel, kind, line, endLine, title, text }) => ({ rel, kind, line, endLine, title, text })) },
    explanations,
    questions: (questions || []).filter(q => q && q.pregunta && q.respuesta)
      .map(q => ({ q: String(q.pregunta), answer: String(q.respuesta), files: (q.archivos || []).map(norm).filter(r => exists(ws, r)) })),
    challenges: (challenges || []).map(c => c && { prompt: String(c.reto || ''), file: norm(c.archivo), hints: (c.pistas || []).map(String).slice(0, 3) })
      .filter(c => c && c.prompt && exists(ws, c.file) && exists(ws, c.file).isFile()),
  };
  fs.mkdirSync(PACKS_DIR, { recursive: true });
  fs.writeFileSync(packFile(ws), JSON.stringify(pack, null, 2));
  say(`Listo: ${Object.keys(explanations).length} explicaciones, ${pack.questions.length} preguntas, ${pack.challenges.length} retos y ${pack.tour.steps.length} paradas de tour.`);
  return { pack, file: packFile(ws) };
}

// cheap offline "search": which pack explanations best match some words?
function search(pack, text, limit = 3) {
  const words = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/).filter(w => w.length >= 3 && !STOP.has(w));
  if (!words.length) return [];
  const clean = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const scored = Object.entries(pack.explanations || {}).map(([rel, txt]) => {
    // file name split into words (VerificarRol.php \u2192 verificar, rol, php) weighs more than the explanation text
    const nameWords = clean(rel.replace(/([a-z])([A-Z])/g, '$1 $2')).split(/[^a-z0-9\u00f1]+/);
    const textWords = clean(txt).split(/[^a-z0-9\u00f1]+/);
    const score = words.reduce((s, w) => s + (nameWords.some(n => n.startsWith(w)) ? 3 : textWords.some(t => t.startsWith(w)) ? 1 : 0), 0);
    return { rel, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
const STOP = new Set('muestrame ensename donde esta como funciona archivo archivos controlador controller cual cuales para porque sobre este esta esto hace hacer quiero saber dime explica explicame proyecto tiene que los las del con una uno por usuario'.split(' '));

module.exports = { load, generate, search, packFile, PACKS_DIR };

// CLI: node src/pack.js "C:\dev\gaya\gaya-vainilla"
if (require.main === module) {
  const ws = process.argv[2];
  if (!ws) { console.error('Uso: node src/pack.js <carpeta del proyecto>'); process.exit(1); }
  brain.initTours(path.join(process.env.APPDATA || require('os').homedir(), 'obsi-boty'));
  const t0 = Date.now();
  generate(ws, m => console.log(`[${Math.round((Date.now() - t0)/1000)}s] ${m}`))
    .then(r => console.log('Guardado en', r.file))
    .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
