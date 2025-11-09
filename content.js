// --------------------------------------------------
// GLOBALS
// --------------------------------------------------
let audioCtx, sourceNode, meydaAnalyzer;
let running = false;
let globalChroma = new Array(12).fill(0);
let lastChord = "--";
let lastKey = "--";
let transpose = 0;

const PC = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function roll(arr, n) {
  const m = ((n % arr.length) + arr.length) % arr.length;
  return arr.slice(m).concat(arr.slice(0, m));
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// --------------------------------------------------
// CREATE CHORD MASKS (Maj + Min)
// --------------------------------------------------
const CHORD_TEMPLATES = (() => {
  const list = [];
  for (let r = 0; r < 12; r++) {
    const maj = new Array(12).fill(0);
    maj[r] = maj[(r+4)%12] = maj[(r+7)%12] = 1;
    list.push({ name: PC[r], mask: maj });
  }
  for (let r = 0; r < 12; r++) {
    const min = new Array(12).fill(0);
    min[r] = min[(r+3)%12] = min[(r+7)%12] = 1;
    list.push({ name: PC[r] + "m", mask: min });
  }
  return list;
})();

// --------------------------------------------------
// FIND BEST KEY
// --------------------------------------------------
function bestKey(chroma) {
  const sum = chroma.reduce((a,b)=>a+b,0) || 1;
  const norm = chroma.map(x => x / sum);

  let best = { name: "--", score: -1 };

  for (let r = 0; r < 12; r++) {
    const majScore = cosineSim(norm, roll(KS_MAJOR, 12-r));
    if (majScore > best.score)
      best = { name: PC[r] + " major", score: majScore };

    const minScore = cosineSim(norm, roll(KS_MINOR, 12-r));
    if (minScore > best.score)
      best = { name: PC[r] + " minor", score: minScore };
  }

  return best.name;
}

// --------------------------------------------------
// FIND BEST CHORD
// --------------------------------------------------
function bestChord(chroma) {
  let best = { name: "--", score: -1 };
  for (const t of CHORD_TEMPLATES) {
    const score = cosineSim(chroma, t.mask);
    if (score > best.score) best = { name: t.name, score };
  }
  return best.name;
}

function applyTranspose(name, semis) {
  if (!name || name === "--") return "--";
  const isMinor = name.endsWith("m");
  const root = isMinor ? name.slice(0,-1) : name;
  const idx = PC.indexOf(root);
  if (idx < 0) return "--";
  return PC[(idx + semis + 1200) % 12] + (isMinor ? "m" : "");
}

// --------------------------------------------------
// DIATONIC CHORDS (from Tonal.js)
// --------------------------------------------------
function diatonic(keyName) {
  if (!keyName || keyName === "--") return [];

  const [root, type] = keyName.split(" ");

  let scaleName = root + " " + (type === "major" ? "major" : "natural minor");
  let scale = Tonal.Scale.get(scaleName).notes;
  let out = [];

  for (let i = 0; i < 6; i++) {
    let triad = Tonal.Chord.triad(scale[i]);
    if (triad) out.push(Tonal.Note.pitchClass(triad));
  }

  return out;
}

// --------------------------------------------------
// UI OVERLAY
// --------------------------------------------------
function ensureOverlay() {
  if (document.getElementById("ytc-overlay")) return;

  const box = document.createElement("div");
  box.id = "ytc-overlay";
  box.innerHTML = `
    <h3>YT Chords & Key</h3>
    <div id="ytc-badge">--</div>
    <div id="ytc-key">Key: --</div>

    <div id="ytc-buttons">
      <button class="ytc-btn" id="ytc-start">Start</button>
      <button class="ytc-btn" id="ytc-stop" disabled>Stop</button>
      <button class="ytc-btn" id="ytc-minus">Transpose -</button>
      <button class="ytc-btn" id="ytc-plus">Transpose +</button>
      <button class="ytc-btn" id="ytc-capo">Capo</button>
    </div>

    <div id="ytc-diatonic"></div>
    <div id="ytc-status">Idle</div>
  `;

  document.body.appendChild(box);

  document.getElementById("ytc-start").onclick = start;
  document.getElementById("ytc-stop").onclick = stop;
  document.getElementById("ytc-minus").onclick = () => { transpose--; updateUI(); };
  document.getElementById("ytc-plus").onclick = () => { transpose++; updateUI(); };
  document.getElementById("ytc-capo").onclick = suggestCapo;
}

function setStatus(msg) {
  const s = document.getElementById("ytc-status");
  if (s) s.textContent = msg;
}

function updateUI() {
  const chordBox = document.getElementById("ytc-badge");
  const keyBox = document.getElementById("ytc-key");
  const chips = document.getElementById("ytc-diatonic");

  chordBox.textContent = applyTranspose(lastChord, transpose);
  keyBox.textContent = "Key: " + applyTranspose(lastKey.split(" ")[0], transpose) +
    (lastKey.includes("minor") ? " minor" : " major");

  const d = diatonic(lastKey);

  chips.innerHTML = "";
  for (const c of d) {
    const chip = document.createElement("span");
    chip.className = "ytc-chip";
    chip.textContent = applyTranspose(c, transpose);
    chips.appendChild(chip);
  }
}

// --------------------------------------------------
// CAPO SUGGESTION
// --------------------------------------------------
function suggestCapo() {
  if (!lastKey || lastKey === "--") {
    setStatus("Play the song first...");
    return;
  }

  const root = lastKey.split(" ")[0];
  const idx = PC.indexOf(root);
  const good = ["C","G","D","A","E"];

  let bestShift = 0;
  for (let s = -6; s <= 6; s++) {
    const newRoot = PC[(idx + s + 1200) % 12];
    if (good.includes(newRoot)) {
      bestShift = s;
      break;
    }
  }

  const capo = ((-bestShift % 12) + 12) % 12;
  setStatus("Try capo " + (capo % 8) + " (simplifies chords)");
}

// --------------------------------------------------
// START LISTENING
// --------------------------------------------------
async function start() {
  if (running) return;

  const video = document.querySelector("video");
  if (!video) return setStatus("No video found.");

  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaElementSource(video);

  meydaAnalyzer = Meyda.createMeydaAnalyzer({
    audioContext: audioCtx,
    source: sourceNode,
    bufferSize: 4096,
    featureExtractors: ["chroma"],
    callback: (f) => {
      const chroma = f.chroma || new Array(12).fill(0);
      const sum = chroma.reduce((a,b)=>a+b,0) || 1;
      const norm = chroma.map(x=>x/sum);

      for (let i = 0; i < 12; i++)
        globalChroma[i] = 0.97*globalChroma[i] + 0.03*norm[i];

      lastChord = bestChord(norm);
      lastKey = bestKey(globalChroma);

      updateUI();
    }
  });

  sourceNode.connect(audioCtx.destination);
  meydaAnalyzer.start();
  running = true;

  document.getElementById("ytc-start").disabled = true;
  document.getElementById("ytc-stop").disabled = false;
  setStatus("Listening...");
}

// --------------------------------------------------
// STOP LISTENING
// --------------------------------------------------
function stop() {
  if (!running) return;

  meydaAnalyzer.stop();
  sourceNode.disconnect();

  running = false;
  document.getElementById("ytc-start").disabled = false;
  document.getElementById("ytc-stop").disabled = true;
  setStatus("Stopped.");
}

// --------------------------------------------------
// INITIALIZE
// --------------------------------------------------
function init() {
  ensureOverlay();
  setStatus("Ready. Press Start.");
}

if (document.readyState === "complete")
  init();
else
  window.addEventListener("DOMContentLoaded", init);
