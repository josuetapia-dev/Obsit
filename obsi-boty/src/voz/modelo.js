// Spanish speech model for Vosk (offline recognition).
// Not in git (40 MB): downloaded once from the official Vosk site the first time someone turns listening on,
// then repacked as modelos/vosk-es.tar.gz with a top-level "model/" folder, the format vosk-browser expects.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');

const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip';
const MODEL_DIR = path.join(__dirname, '..', '..', 'modelos');
const MODEL_FILE = path.join(MODEL_DIR, 'vosk-es.tar.gz');

const exists = () => fs.existsSync(MODEL_FILE) && fs.statSync(MODEL_FILE).size > 10e6;

function download(url, dest, onProgress, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); return resolve(download(new URL(res.headers.location, url).href, dest, onProgress, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`descarga falló (HTTP ${res.statusCode})`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', d => {
        got += d.length;
        const pct = total ? Math.floor(got / total * 100) : 0;
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onProgress(pct); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// Windows' own bsdtar (reads .zip too); avoids picking up Git's GNU tar from PATH
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const tar = (args, cwd) => new Promise((resolve, reject) =>
  execFile(TAR, args, { cwd, windowsHide: true }, err => err ? reject(new Error('no pude descomprimir el modelo (' + err.message + ')')) : resolve()));

async function ensure(onProgress = () => {}) {
  if (exists()) return MODEL_FILE;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obsi-vosk-'));
  try {
    const zip = path.join(tmp, 'model.zip');
    await download(MODEL_URL, zip, pct => onProgress(`Descargando el modelo de voz en español: ${pct}%`));
    onProgress('Preparando el modelo de voz');
    await tar(['-xf', zip], tmp);                                   // Windows 10+ tar.exe also reads .zip
    const folder = fs.readdirSync(tmp).find(n => n.startsWith('vosk-model'));
    if (!folder) throw new Error('el modelo descargado no tiene la forma esperada');
    fs.renameSync(path.join(tmp, folder), path.join(tmp, 'model'));
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    await tar(['-czf', MODEL_FILE, 'model'], tmp);
    return MODEL_FILE;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { ensure, exists, MODEL_FILE };
