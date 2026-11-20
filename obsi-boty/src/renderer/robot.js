// Obsi-boty — the 3D robot (renderer process)
// Desktop version of prototipo/obsi-boty-3d.html: transparent background, no post-processing
// (the glow is faked with cheap layers), driven by the global cursor and the main process.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const obsi = window.obsi || { setIgnore(){}, dragStart(){}, dragEnd(){}, click(){}, menu(){}, onCursor(){}, onState(){} };

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, premultipliedAlpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

// studio environment: dark room, one soft top light (like the Gemini renders) + purple bounce
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color:0x07050c, side:THREE.BackSide })));
const envPanel = (w, h, col, pos) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ side:THREE.DoubleSide }));
  m.material.color.setRGB(...col); m.position.set(...pos); m.lookAt(0, 0, 0); envScene.add(m); };
envPanel(10, 5, [1.1, 1.1, 1.15], [0, 9, 5]);
envPanel(4, 6, [0.35, 0.35, 0.4], [-9, 2, 4]);
envPanel(12, 4, [0.18, 0.08, 0.45], [0, -8, -4]);
scene.environment = pmrem.fromScene(envScene, 0).texture;

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 0.35, 9.2);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.15));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-3, 4, 5); scene.add(key);
const rim = new THREE.PointLight(0x8b5cf6, 30, 12); rim.position.set(0, 1.5, -3); scene.add(rim);

// ---------- materials ----------
const obsidian = new THREE.MeshPhysicalMaterial({
  color:0x0e0a16, metalness:0.15, roughness:0.12, clearcoat:1, clearcoatRoughness:0.04,
  sheen:0.5, sheenColor:new THREE.Color(0x5b2fc0), sheenRoughness:0.4, envMapIntensity:1
});
const purpleGloss = new THREE.MeshPhysicalMaterial({ color:0x5a2bc2, roughness:0.22, clearcoat:1, clearcoatRoughness:0.08, envMapIntensity:1.1 });
const metal = new THREE.MeshPhysicalMaterial({ color:0x17121f, metalness:0.65, roughness:0.22, clearcoat:1, clearcoatRoughness:0.05, envMapIntensity:1.2 });
const glow = (r,g,b) => { const m = new THREE.MeshBasicMaterial({ toneMapped:false }); m.color.setRGB(r,g,b); return m; };
const softGlow = (r,g,b,o) => { const m = new THREE.MeshBasicMaterial({ transparent:true, opacity:o, depthWrite:false, blending:THREE.AdditiveBlending, toneMapped:false }); m.color.setRGB(r,g,b); return m; };

function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64,64,0,64,64,64);
  stops.forEach(([o,col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0,0,128,128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- rig ----------
const rig = new THREE.Group(); scene.add(rig);          // floats up/down
const body = new THREE.Group(); rig.add(body);          // turns toward the cursor

const R = 1;
const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48), obsidian);
body.add(sphere);

// rim glow: purple fresnel edge
const rimMat = new THREE.ShaderMaterial({
  uniforms:{ uColor:{ value:new THREE.Color(0.5, 0.26, 1.35) }, uStr:{ value:1 } },
  vertexShader:`varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader:`uniform vec3 uColor; uniform float uStr; varying vec3 vN; varying vec3 vV;
    void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.6); gl_FragColor = vec4(uColor * f * uStr, f * uStr); }`,
  transparent:true, blending:THREE.AdditiveBlending, depthWrite:false
});
body.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.008, 48, 32), rimMat));

// face: canvas texture on a front patch of the sphere
const FW = 768, FH = 640, FACE_SCALE = 2/3;   // drawn at 512x427, code keeps 768x640 coordinates
const faceCanvas = document.createElement('canvas'); faceCanvas.width = Math.round(FW*FACE_SCALE); faceCanvas.height = Math.round(FH*FACE_SCALE);
const fctx = faceCanvas.getContext('2d');
fctx.setTransform(FACE_SCALE, 0, 0, FACE_SCALE, 0, 0);
const faceTex = new THREE.CanvasTexture(faceCanvas); faceTex.colorSpace = THREE.SRGBColorSpace;
const pw = 1.55, ph = 1.3, center = Math.PI/2 - 0.1;
const faceMat = new THREE.MeshBasicMaterial({ map:faceTex, transparent:true, depthWrite:false, toneMapped:false });
faceMat.color.setRGB(1.3, 1.22, 1.45);
body.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.004, 40, 32, Math.PI/2 - pw/2, pw, center - ph/2, ph), faceMat));

// antenna
const antBase = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 16, 0, Math.PI*2, 0, Math.PI/2), obsidian);
antBase.position.y = 0.975; body.add(antBase);
const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 12), obsidian);
stick.position.y = 1.2; body.add(stick);
const tipMat = glow(1, 0.75, 1.6);
const tip = new THREE.Mesh(new THREE.SphereGeometry(0.065, 24, 24), tipMat);
tip.position.y = 1.38; body.add(tip);
const tipHaloMat = new THREE.SpriteMaterial({ map:radialTexture([[0,'rgba(200,160,255,0.9)'],[1,'rgba(150,90,255,0)']]), depthWrite:false, blending:THREE.AdditiveBlending });
const tipHalo = new THREE.Sprite(tipHaloMat); tipHalo.scale.setScalar(0.4); tipHalo.position.y = 1.38; body.add(tipHalo);

// ring: thin bright core + wide faint halo (fake bloom)
const ringPivot = new THREE.Group(); ringPivot.rotation.set(1.28, 0, 0.3); body.add(ringPivot);
const ringSpin = new THREE.Group(); ringPivot.add(ringSpin);
const ringMat = glow(0.6, 0.32, 1.3);
ringSpin.add(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.03, 12, 128), ringMat));
const ringHaloMat = softGlow(0.55, 0.25, 1.2, 0.22);
ringSpin.add(new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.085, 12, 128), ringHaloMat));
const beadMat = glow(1.6, 1.2, 2.4);
for (const a of [0, Math.PI]) {
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 16), beadMat);
  bead.position.set(Math.cos(a)*1.5, Math.sin(a)*1.5, 0); ringSpin.add(bead);
}

// scan line (for "leyendo código")
const scan = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 128), glow(1.3, 1.1, 2.2));
scan.rotation.x = Math.PI/2; scan.visible = false; body.add(scan);

// aura (always behind the sphere; keeps him visible on dark backgrounds)
const auraMat = new THREE.SpriteMaterial({ map:radialTexture([[0,'rgba(150,95,255,0.75)'],[0.42,'rgba(130,70,240,0.45)'],[0.62,'rgba(110,60,220,0.12)'],[1,'rgba(100,50,200,0)']]), depthWrite:false });
const aura = new THREE.Sprite(auraMat); aura.scale.set(3.2, 3.2, 1); aura.position.z = -0.6; body.add(aura);

// floating symbol (! ? z { } ♥)
const symCanvas = document.createElement('canvas'); symCanvas.width = symCanvas.height = 256;
const sctx = symCanvas.getContext('2d');
const symTex = new THREE.CanvasTexture(symCanvas); symTex.colorSpace = THREE.SRGBColorSpace;
const symMat = new THREE.SpriteMaterial({ map:symTex, depthWrite:false, toneMapped:false });
const sym = new THREE.Sprite(symMat); sym.scale.set(0.75, 0.75, 1); sym.position.set(1.2, 1.35, 0.3); rig.add(sym);
function setSymbol(s) {
  sctx.clearRect(0,0,256,256); sym.visible = !!s; if (!s) return;
  sctx.font = `600 ${s.length > 1 ? 110 : 170}px system-ui, "Segoe UI", sans-serif`;
  sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
  sctx.shadowColor = 'rgba(180,140,255,1)'; sctx.shadowBlur = 24; sctx.fillStyle = '#d9c9ff';
  sctx.fillText(s, 128, 136); symTex.needsUpdate = true;
}

// sparkles (celebrar)
const starC = document.createElement('canvas'); starC.width = starC.height = 64;
{ const g = starC.getContext('2d'); g.fillStyle = '#e4d8ff'; g.shadowColor = '#b38cff'; g.shadowBlur = 10;
  g.beginPath(); g.moveTo(32,4); g.quadraticCurveTo(36,28,60,32); g.quadraticCurveTo(36,36,32,60); g.quadraticCurveTo(28,36,4,32); g.quadraticCurveTo(28,28,32,4); g.fill(); }
const starTex = new THREE.CanvasTexture(starC);
const sparkles = [];
for (let i = 0; i < 12; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:starTex, depthWrite:false, toneMapped:false }));
  s.userData = { a:i/12*Math.PI*2, r:1.6 + Math.random()*0.4, ph:Math.random()*6 };
  s.visible = false; rig.add(s); sparkles.push(s);
}

// ambient motes
const dotTex = radialTexture([[0,'rgba(220,200,255,1)'],[0.35,'rgba(170,120,255,0.6)'],[1,'rgba(140,90,255,0)']]);
const motes = [];
for (let i = 0; i < 16; i++) {
  const m = new THREE.Sprite(new THREE.SpriteMaterial({ map:dotTex, depthWrite:false, transparent:true, toneMapped:false }));
  m.userData = { a:Math.random()*Math.PI*2, r:1.7 + Math.random()*0.6, y:(Math.random() - 0.5)*2.2, sp:0.05 + Math.random()*0.12, ph:Math.random()*6, s:0.05 + Math.random()*0.07 };
  rig.add(m); motes.push(m);
}

// ---------- hands: robotic, articulated ----------
const jointGlow = glow(0.75, 0.38, 1.9);
function makeHand(side) {
  const g = new THREE.Group(), fingers = [];
  g.add(new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.23, 0.13, 4, 0.05), metal));
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.014, 0.01), jointGlow); strip.position.set(0, -0.04, 0.068); g.add(strip);
  const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 20), jointGlow); wrist.position.y = -0.165; g.add(wrist);
  const wristRing = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.018, 10, 32), purpleGloss); wristRing.rotation.x = Math.PI/2; wristRing.position.y = -0.165; g.add(wristRing);
  const finger = (x, y, rotZ, l1, l2, r) => {
    const base = new THREE.Group(); base.position.set(x, y, 0); base.rotation.z = rotZ; g.add(base);
    base.add(new THREE.Mesh(new THREE.SphereGeometry(r*0.95, 14, 14), jointGlow));
    const s1 = new THREE.Mesh(new THREE.CapsuleGeometry(r, l1, 6, 12), metal); s1.position.y = l1/2 + r*0.9; base.add(s1);
    const joint = new THREE.Group(); joint.position.y = l1 + r*1.8; base.add(joint);
    joint.add(new THREE.Mesh(new THREE.SphereGeometry(r*0.85, 12, 12), jointGlow));
    const s2 = new THREE.Mesh(new THREE.CapsuleGeometry(r*0.95, l2, 6, 12), purpleGloss); s2.position.y = l2/2 + r*0.85; joint.add(s2);
    fingers.push({ base, joint });
  };
  for (let i = 0; i < 3; i++) finger((i-1)*0.085, 0.13, -(i-1)*0.12, i === 1 ? 0.08 : 0.065, i === 1 ? 0.07 : 0.06, 0.036);
  finger(-side*0.15, 0.0, side*1.0, 0.05, 0.05, 0.034);   // thumb
  g.userData.fingers = fingers;
  rig.add(g); return g;
}
const L = makeHand(-1), Rh = makeHand(1);
// finger curl per hand: [left, middle, right, thumb] in radians
function curlHand(h, curl, k) {
  h.userData.fingers.forEach((f, i) => {
    f.base.rotation.x += (curl[i]*0.45 - f.base.rotation.x)*k;
    f.joint.rotation.x += (curl[i] - f.joint.rotation.x)*k;
  });
}

// invisible, slightly larger sphere: makes him easier to grab
const hitProxy = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 12), new THREE.MeshBasicMaterial({ visible:false }));
body.add(hitProxy);

// ---------- states ----------
const P = (p, r) => ({ p:new THREE.Vector3(...p), r:new THREE.Vector3(...r) });
const idleL = P([-1.6,-0.5,0.25],[0,0.3,2.8]), idleR = P([1.6,-0.5,0.25],[0,-0.3,-2.8]);
const OPEN = [0.05, 0, 0.05, 0.1], RELAX = [0.4, 0.35, 0.4, 0.3], FIST = [1.5, 1.5, 1.5, 1.1];
const STATES = {
  reposo:     { face:'neutral',   L:idleL, R:idleR, spin:0.6, glow:1 },
  saludar:    { face:'happy',     L:idleL, R:P([1.55,0.65,0.35],[0,-0.2,-0.25]), curlR:OPEN, waveR:true, spin:1, glow:1.2 },
  escuchar:   { face:'listening', L:idleL, R:P([1.45,0.15,0.4],[0,-0.8,0.3]), curlR:[0.55,0.45,0.55,0.3], spin:0.8, glow:1.2, tilt:0.15 },
  curioso:    { face:'curious',   L:idleL, R:P([0.55,-0.88,1.05],[-0.3,0,0.4]), curlR:[1.0,0.9,1.0,0.5], spin:0.8, glow:1.1, tilt:0.18 },
  pensar:     { face:'thinking',  L:idleL, R:P([0.6,-0.82,1.05],[-0.3,0,0.3]), curlR:[1.1,0.25,1.1,0.6], tap:true, spin:3.2, glow:1.9, sym:'{ }' },
  escanear:   { face:'scanning',  L:P([-1.55,-0.75,0.25],[0,0.3,2.9]), R:P([1.55,-0.75,0.25],[0,-0.3,-2.9]), spin:2.2, glow:1.6, scan:true },
  explicar:   { face:'happy',     L:P([-1.8,0.2,0.4],[0,0.3,1.35]), R:idleR, curlL:[1.5,0,1.5,1.2], spin:1, glow:1.2, point:true },
  sorpresa:   { face:'surprised', L:P([-1.7,0.15,0.3],[0,0,0.6]), R:P([1.7,0.15,0.3],[0,0,-0.6]), curlL:OPEN, curlR:OPEN, spin:1.5, glow:1.5, sym:'!' },
  confundido: { face:'confused',  L:idleL, R:P([0.75,1.05,0.45],[0,0,2.3]), curlR:[0.7,0.5,0.7,0.4], scratch:true, spin:0.7, glow:1, sym:'?' },
  pregunta:   { face:'curious',   L:idleL, R:P([1.5,0.75,0.35],[0,-0.2,-0.15]), curlR:[1.4,0,1.4,1.1], spin:1.4, glow:1.5, sym:'?', tilt:0.12 },   // raises one finger: "a question!"
  celebrar:   { face:'joy',       L:P([-1.5,0.95,0.3],[0,0,0.3]), R:P([1.5,0.95,0.3],[0,0,-0.3]), curlL:OPEN, curlR:OPEN, waveL:true, waveR:true, spin:3, glow:2, sparkles:true },
  ups:        { face:'oops',      L:idleL, R:P([1.05,0.15,-0.9],[0,0,0.5]), curlR:FIST, spin:0.8, glow:1, tilt:-0.12 },
  amor:       { face:'love',      L:P([-1.3,-0.25,0.75],[0,0,0.3]), R:P([1.3,-0.25,0.75],[0,0,-0.3]), curlL:[0.25,0.2,0.25,0.2], curlR:[0.25,0.2,0.25,0.2], spin:1.2, glow:1.5, sym:'♥' },
  cargado:    { face:'surprised', L:P([-1.25,-1.05,0.2],[0,0.3,3.0]), R:P([1.25,-1.05,0.2],[0,-0.3,-3.0]), spin:2.5, glow:1.4, carried:true },
  dormir:     { face:'sleeping',  L:P([-1.45,-1.15,0.2],[0,0.3,2.95]), R:P([1.45,-1.15,0.2],[0,-0.3,-2.95]), curlL:[0.8,0.75,0.8,0.5], curlR:[0.8,0.75,0.8,0.5], spin:0.15, glow:0.45, sym:'z', sleep:true },
};

let state = 'saludar', S = STATES[state];
let revertTimer = null, prevFace = 'neutral', faceMix = 1, popT = 9;
function setState(k, revertTo, ms) {
  if (!STATES[k]) return;
  if (STATES[k].face !== S.face) { prevFace = S.face; faceMix = 0; }
  if (k !== state) popT = 0;
  state = k; S = STATES[k]; setSymbol(S.sym);
  scan.visible = !!S.scan; sparkles.forEach(s => s.visible = !!S.sparkles);
  clearTimeout(revertTimer);
  if (revertTo) revertTimer = setTimeout(() => setState(revertTo), ms);
}
setState('saludar', 'reposo', 2800);

let lastPoke = performance.now();
const poke = () => { lastPoke = performance.now(); };

// ---------- face drawing ----------
const EYE = '#dccdff', PUPIL = '#7b5ad6';
function pill(x, y, w, h) { fctx.beginPath(); fctx.roundRect(x-w/2, y-h/2, w, h, Math.min(w, h)/2); fctx.fill(); }
function eyeball(x, y, r, lx, ly, squash = 0) {
  fctx.fillStyle = EYE; fctx.beginPath(); fctx.ellipse(x, y, r, Math.max(5, r*(1-squash)), 0, 0, Math.PI*2); fctx.fill();
  if (squash < 0.6) { fctx.save(); fctx.shadowBlur = 0; fctx.fillStyle = PUPIL;
    fctx.beginPath(); fctx.ellipse(x + lx*r*0.42, y + ly*r*0.42, r*0.38, r*0.38*(1-squash), 0, 0, Math.PI*2); fctx.fill(); fctx.restore(); }
}
function heart(x, y, s) {
  fctx.beginPath(); fctx.moveTo(x, y + s*0.75);
  fctx.bezierCurveTo(x - s*1.3, y - s*0.1, x - s*0.6, y - s*1.1, x, y - s*0.4);
  fctx.bezierCurveTo(x + s*0.6, y - s*1.1, x + s*1.3, y - s*0.1, x, y + s*0.75); fctx.fill();
}
function drawFace(expr, blink, lx, ly, alpha = 1, clear = true, cheeks = true) {
  if (clear) fctx.clearRect(0, 0, FW, FH);
  const cy = FH*0.42, ex = 132, xs = [FW/2 - ex, FW/2 + ex];
  fctx.save(); fctx.globalAlpha = alpha;
  fctx.shadowColor = 'rgba(185,150,255,0.95)'; fctx.shadowBlur = 34;
  fctx.fillStyle = EYE; fctx.strokeStyle = EYE; fctx.lineCap = 'round'; fctx.lineJoin = 'round';
  const ox = lx*26, oy = ly*20;
  switch (expr) {
    case 'neutral': case 'listening': {
      const w = expr === 'listening' ? 64 : 58, h = Math.max(12, (expr === 'listening' ? 145 : 132)*(1-blink));
      xs.forEach(x => pill(x + ox, cy + oy, w, h)); break; }
    case 'happy': case 'joy':
      fctx.lineWidth = 24; xs.forEach(x => { fctx.beginPath(); fctx.arc(x + ox*0.4, cy + 28, 48, Math.PI*1.06, Math.PI*1.94); fctx.stroke(); });
      if (expr === 'joy') { fctx.beginPath(); fctx.moveTo(FW/2 - 62, cy + 62); fctx.lineTo(FW/2 + 62, cy + 62); fctx.quadraticCurveTo(FW/2, cy + 150, FW/2 - 62, cy + 62); fctx.fill(); }
      break;
    case 'surprised': xs.forEach(x => eyeball(x, cy, 64, lx*0.6, ly*0.6, blink)); break;
    case 'curious': eyeball(xs[0] - 6, cy - 6, 74, 0.5 + lx*0.3, ly*0.4, blink); eyeball(xs[1] + 6, cy + 10, 46, 0.5 + lx*0.3, ly*0.4, blink); break;
    case 'thinking': xs.forEach(x => eyeball(x, cy, 58, 0.65, -0.8, blink)); break;
    case 'scanning':
      xs.forEach(x => { fctx.save(); fctx.beginPath(); fctx.rect(x - 90, cy - 8, 180, 140); fctx.clip();
        eyeball(x, cy, 60, Math.sin(performance.now()/350)*0.6, 0.85); fctx.restore(); }); break;
    case 'sleeping':
      fctx.lineWidth = 14; xs.forEach(x => { fctx.beginPath(); fctx.arc(x, cy - 12, 44, Math.PI*0.18, Math.PI*0.82); fctx.stroke(); }); break;
    case 'confused':
      eyeball(xs[0], cy - 4, 68, 0.35, 0.15, blink);
      fctx.save(); fctx.beginPath(); fctx.moveTo(xs[1] - 70, cy - 8); fctx.lineTo(xs[1] + 70, cy - 40); fctx.lineTo(xs[1] + 70, cy + 80); fctx.lineTo(xs[1] - 70, cy + 80); fctx.clip();
      eyeball(xs[1], cy + 10, 46, -0.3, 0.2); fctx.restore(); break;
    case 'oops': {
      fctx.lineWidth = 22; fctx.beginPath(); fctx.arc(xs[0], cy + 26, 46, Math.PI*1.06, Math.PI*1.94); fctx.stroke();
      fctx.beginPath(); fctx.moveTo(xs[1] + 34, cy - 38); fctx.lineTo(xs[1] - 28, cy); fctx.lineTo(xs[1] + 34, cy + 38); fctx.stroke();
      const dx = FW/2 + 255, dy = FH*0.16; fctx.fillStyle = '#c9d4ff'; fctx.beginPath();
      fctx.moveTo(dx, dy - 42); fctx.quadraticCurveTo(dx + 30, dy, dx + 26, dy + 14); fctx.arc(dx, dy + 14, 26, 0, Math.PI); fctx.quadraticCurveTo(dx - 30, dy, dx, dy - 42); fctx.fill();
      break; }
    case 'love': xs.forEach(x => heart(x + ox*0.4, cy + 6, 62)); break;
  }
  fctx.restore();
  if (!cheeks) return;
  fctx.save(); fctx.shadowColor = 'rgba(255,110,210,0.9)'; fctx.shadowBlur = 22; fctx.fillStyle = '#ff7fd6';
  fctx.globalAlpha = expr === 'sleeping' ? 0.45 : 0.9;
  for (const s of [-1, 1]) { fctx.beginPath(); fctx.arc(FW/2 + s*212, FH*0.6, 21, 0, Math.PI*2); fctx.fill(); }
  fctx.restore();
  faceTex.needsUpdate = true;
}

// ---------- interaction ----------
const mouse = new THREE.Vector2(), look = new THREE.Vector2();
let lastMove = 0, lastCursor = null;
const clamp = v => Math.max(-1, Math.min(1, v));

// global cursor from the main process (pixels from the window center)
obsi.onCursor(p => {
  mouse.set(clamp(p.x/520), clamp(p.y/360));
  if (!lastCursor || Math.abs(p.x - lastCursor.x) + Math.abs(p.y - lastCursor.y) > 3) { lastMove = performance.now(); poke(); }
  lastCursor = p;
});
obsi.onState(s => { poke(); setState(s.name, s.revert, s.ms); });

// click-through everywhere except over the robot
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let overRobot = false, dragging = null;
function hitTest(e) {
  ndc.set(e.clientX/innerWidth*2 - 1, -(e.clientY/innerHeight)*2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObjects([hitProxy, L, Rh], true).length > 0;
}
addEventListener('mousemove', e => {
  if (dragging) {
    const moved = Math.abs(e.screenX - dragging.x) + Math.abs(e.screenY - dragging.y);
    if (moved > 6 && !dragging.moved) { dragging.moved = true; setState('cargado'); }
    return;
  }
  const hit = hitTest(e);
  if (hit !== overRobot) { overRobot = hit; obsi.setIgnore(!hit); document.body.style.cursor = hit ? 'grab' : 'default'; }
});
addEventListener('mousedown', e => {
  if (e.button !== 0 || !hitTest(e)) return;
  dragging = { x:e.screenX, y:e.screenY, moved:false };
  obsi.dragStart(); poke();
});
addEventListener('mouseup', e => {
  if (e.button !== 0 || !dragging) return;
  const wasDrag = dragging.moved; dragging = null;
  obsi.dragEnd(); poke();
  if (wasDrag) setState('reposo');
  else obsi.click();          // main decides: explain the open file, or ask for one
});
addEventListener('contextmenu', e => { e.preventDefault(); if (hitTest(e)) obsi.menu(); });

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- loop ----------
const clock = new THREE.Clock();
let blinkAt = 2, blinkT = -1, glowNow = 1, spinNow = 0.6, lastFaceKey = '';
const tmpE = new THREE.Vector3(), tmpR = new THREE.Vector3(), extra = new THREE.Vector3();
const HAND_X = 0.82;   // pulls every hand pose closer to the body (1 = original distance)
function moveHand(h, pose, t, dt, side, add) {
  const k = 1 - Math.exp(-dt*7);
  tmpE.copy(pose.p); tmpE.x *= HAND_X; tmpE.y += Math.sin(t*2.1 + side) * (S.sleep ? 0.03 : 0.06);
  h.position.lerp(tmpE, k);
  tmpR.copy(pose.r); if (add) tmpR.add(add);
  h.rotation.x += (tmpR.x - h.rotation.x)*k; h.rotation.y += (tmpR.y - h.rotation.y)*k; h.rotation.z += (tmpR.z - h.rotation.z)*k;
}
L.position.copy(idleL.p); Rh.position.copy(idleR.p);

// frame limiter: 30 fps awake, 12 asleep
let lastFrame = 0;
function tick(now = 0) {
  requestAnimationFrame(tick);
  const fps = S.sleep ? 12 : 30;
  if (now - lastFrame < 1000/fps - 2) return;
  lastFrame = now;
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (state !== 'dormir' && !dragging && performance.now() - lastPoke > 60000) setState('dormir');
  if (state === 'dormir' && performance.now() - lastPoke < 300) setState('saludar', 'reposo', 2000);

  // float
  rig.position.y = S.sleep ? Math.sin(t*0.8)*0.05 - 0.12 : Math.sin(t*1.6)*0.09;

  // look at cursor; if the cursor is still for 4 s he looks around on his own
  const follow = S.sleep ? 0 : 1;
  const wander = performance.now() - lastMove > 4000;
  const tx = wander ? Math.sin(t*0.45)*0.7 + Math.sin(t*1.3)*0.15 : mouse.x;
  const ty = wander ? Math.sin(t*0.31)*0.35 : mouse.y;
  const lk = 1 - Math.exp(-dt*(wander ? 2 : 5));
  look.x += (tx*follow - look.x)*lk; look.y += (ty*follow - look.y)*lk;
  body.rotation.y = look.x*0.45;
  body.rotation.x = look.y*0.22;
  body.rotation.z += ((S.tilt || 0) - body.rotation.z)*(1 - Math.exp(-dt*5));

  // ring + glow
  spinNow += (S.spin - spinNow)*(1 - Math.exp(-dt*3));
  glowNow += (S.glow - glowNow)*(1 - Math.exp(-dt*3));
  ringSpin.rotation.z += spinNow*dt;
  ringPivot.rotation.x = 1.28 + Math.sin(t*(S.carried ? 7 : 0.9))*(S.carried ? 0.18 : 0.05);
  ringMat.color.setRGB(0.42*glowNow, 0.16*glowNow, 1.15*glowNow);
  ringHaloMat.opacity = 0.12 + glowNow*0.1;
  const pulse = 0.75 + 0.25*Math.sin(t*3);
  tipMat.color.setRGB(0.85*glowNow, 0.55*glowNow, 1.6*glowNow).multiplyScalar(pulse);
  tipHaloMat.opacity = Math.min(1, 0.35 + glowNow*0.3) * pulse;
  auraMat.opacity = Math.min(1, 0.45 + glowNow*0.4);
  rim.intensity = 18 + glowNow*14;
  rimMat.uniforms.uStr.value = 0.55 + glowNow*0.5;

  if (scan.visible) { const a = Math.sin(t*2.2)*0.95, c = Math.cos(a)*1.012; scan.position.y = Math.sin(a)*1.012; scan.scale.set(c, c, 1); }

  // hands
  const w = Math.sin(t*11)*0.45;
  moveHand(L, S.L, t, dt, -1, S.waveL ? extra.set(0, 0, -w) : S.point ? extra.set(0, 0, Math.sin(t*4)*0.08) : S.carried ? extra.set(0, 0, Math.sin(t*6)*0.2) : null);
  moveHand(Rh, S.R, t, dt, 1, S.waveR ? extra.set(0, 0, w) : S.tap ? extra.set(Math.sin(t*6)*0.15, 0, 0) : S.scratch ? extra.set(0, 0, Math.sin(t*14)*0.25) : S.carried ? extra.set(0, 0, -Math.sin(t*6 + 1)*0.2) : null);
  const ck = 1 - Math.exp(-dt*9);
  curlHand(L, S.curlL || RELAX, ck); curlHand(Rh, S.curlR || RELAX, ck);

  // symbol, sparkles, motes
  if (sym.visible) {
    if (S.sleep) { const p = (t*0.5) % 1; sym.position.set(1.0 + p*0.4, 1.2 + p*0.6, 0.3); symMat.opacity = Math.sin(p*Math.PI); }
    else { sym.position.set(1.2, 1.35 + Math.sin(t*3)*0.06, 0.3); symMat.opacity = 1; }
  }
  sparkles.forEach(s => { if (!s.visible) return; const u = s.userData, tw = (Math.sin(t*5 + u.ph) + 1)/2;
    s.position.set(Math.cos(u.a + t*0.4)*u.r, Math.sin(u.a + t*0.4)*u.r*0.8 + 0.2, 0.4); s.scale.setScalar(0.12 + tw*0.18); });
  motes.forEach(m => { const u = m.userData, ang = u.a + t*u.sp*(1 + glowNow*0.6);
    m.position.set(Math.cos(ang)*u.r, u.y + Math.sin(t*0.6 + u.ph)*0.15, Math.sin(ang)*u.r*0.6 - 0.3);
    m.material.opacity = (0.25 + 0.45*(Math.sin(t*1.7 + u.ph) + 1)/2) * Math.min(1, glowNow);
    m.scale.setScalar(u.s); });

  // blink
  let blink = 0;
  if (t > blinkAt && blinkT < 0) blinkT = 0;
  if (blinkT >= 0) { blinkT += dt/0.16; blink = 1 - Math.abs(blinkT*2 - 1); if (blinkT >= 1) { blinkT = -1; blinkAt = t + 2.5 + Math.random()*3; blink = 0; } }

  // repaint the face texture only when something visible changed
  faceMix = Math.min(1, faceMix + dt/0.22);
  const faceKey = `${S.face}|${prevFace}|${faceMix.toFixed(2)}|${blink.toFixed(2)}|${Math.round(look.x*20)}|${Math.round(look.y*20)}|${S.face === 'scanning' ? Math.floor(t*15) : 0}`;
  if (faceKey !== lastFaceKey) {
    lastFaceKey = faceKey;
    if (faceMix < 1) {
      drawFace(prevFace, 0, look.x, look.y, 1 - faceMix, true, false);
      drawFace(S.face, blink, look.x, look.y, faceMix, false, true);
    } else drawFace(S.face, blink, look.x, look.y);
  }

  // squash & stretch "pop" on state change
  popT += dt;
  const a = popT < 0.4 ? Math.sin(popT/0.4*Math.PI) * 0.07 * (1 - popT/0.4*0.5) : 0;
  body.scale.set(1 - a*0.5, 1 + a, 1 - a*0.5);

  renderer.render(scene, camera);
}
requestAnimationFrame(tick);
