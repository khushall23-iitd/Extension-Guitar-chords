// --- Load libraries (Meyda for audio features, Tonal for music theory) ---
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.documentElement.appendChild(s);
  });
}

// Use pinned versions for stability
const LIBS = [
  "https://unpkg.com/meyda@5.6.3/dist/web/meyda.min.js",
  "https://unpkg.com/@tonaljs/tonal@4.12.5/build/es5/tonal.min.js"
];

let libsLoaded = (async () => {
  for (const url of LIBS) await injectScript(url);
})();

// --- UI Overlay ---
function ensureOverlay() {
  if (document.getElementById("ytc-overlay")) return;

  const box = document.createElement("div");
  box.id = "ytc-overlay";
  box.innerHTML = `
    <h3>YT Chords & Key</h3>
    <div id="ytc-row">
      <div id="ytc-badge">--</div>
      <div id="ytc-key">Key: --</div>
    </div>
    <div id="ytc-buttons">
      <button class="ytc-btn" id="ytc-start">Start</button>
      <button class="ytc-btn" id="ytc-stop" disabled>Stop</button>
      <button class="ytc-btn" id="ytc-transpose--">Transpose -</button>
      <button class="ytc-btn" id="ytc-transpose-+">Transpose +</button>
      <button class="ytc-btn" id="ytc-capo">Capo Suggest</button>
    </div>
    <div id="ytc-diatonic"></div>
    <div id="ytc-status">Idle</div>
  `;
  document.body.appendChild(box);

  document.getElementById("ytc-start").onclick = start;
  document.getElementById("ytc-stop").onclick = stop;
  document.getElementById("ytc-transpose--").onclick = () => { transposeSemis(-1); };
  document.getElementById("ytc-transpose-+").onclick = () => { transposeSemis(1); };
  document.getElementById("ytc-capo").onclick = suggestCapo;
}

let audioCtx, srcNode, analyzer, meydaAnalyzer;
let running = false;
let transpose = 0;     // visual transpose (in semitones)
let globalChroma = new Array(12).fill(0); // accumulate for key detection
let lastChord = "--", lastKey = null;

// Pitch classes
const PC = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];

// Krumhansl-Schmuckler key profiles (roughly normalized)
const KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function roll(arr, n) {
  const m = ((n % arr.length) + arr.length) % arr.length;
  return arr.slice(m).concat(arr.slice(0, m));
}

function cosineSim(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0; i<a.length; i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return (dot / (Math.sqrt(na)*Math.sqrt(nb)+1e-9));
}

// Simple chord templates: 12 major + 12 minor triads as chroma masks
const CHORD_TEMPLATES = (() => {
  const base = [];
  for (let r=0; r<12; r++) {
    const maj = new Array(12).fill(0);
    maj[r]=1; maj[(r+4)%12]=1; maj[(r+7)%12]=1;
    base.push({name: PC[r]+"", type:"maj", mask:maj});
  }
  for (let r=0; r<12; r++) {
    const min = new Array(12).fill(0);
    min[r]=1; min[(r+3)%12]=1; min[(r+7)%12]=1;
    base.push({name: PC[r]+"m", type:"min", mask:min});
  }
  return base;
})();

function bestKey(chroma) {
  // Compare to all 12 rotations of major/minor KS profiles
  let best = {name:null, score:-1};
  const sum = chroma.reduce((a,b)=>a+b,0) || 1;
  const norm = chroma.map(x=>x/sum);
  for (let r=0; r<12; r++){
    const majScore = cosineSim(norm, roll(KS_MAJOR, 12-r));
    if (majScore > best.score) best = {name: PC[r]+" major", score:majScore};
    const minScore = cosineSim(norm, roll(KS_MINOR, 12-r));
    if (minScore > best.score) best = {name: PC[r]+" minor", score:minScore};
  }
  return best.name;
}

function bestChord(chroma) {
  // Template match with cosine similarity
  let best = {name:"--", score:-1};
  for (const t of CHORD_TEMPLATES) {
    const s = cosineSim(chroma, t.mask);
    if (s > best.score) best = {name: t.name, score: s};
  }
  return best.name;
}

function applyTranspose(name, semis) {
  if (!name || name === "--") return name;
  const isMinor = name.endsWith("m");
  const root = isMinor ? name.slice(0,-1) : name;
  const idx = PC.indexOf(root);
  if (idx < 0) return name;
  const out = PC[(idx + semis + 1200) % 12] + (isMinor ? "m" : "");
  return out;
}

function diatonicChords(keyName) {
  if (!keyName) return [];
  const [root, qual] = keyName.split(" ");
  // Use Tonal for proper scale triads
  try {
    const Scale = tonal.Scale; const Chord = tonal.Chord; const Note = tonal.Note;
    const type = qual === "major" ? "major" : "natural minor";
    const scale = Scale.get(`${root} ${type}`).notes;
    // I ii iii IV V vi (vii° rarely used)
    const triads = [0,1,2,3,4,5].map(i => tonal.Chord.triads(scale[i])[0] || "");
    // Fallback: build simple diatonic triads
    const named = triads.filter(Boolean).slice(0,6);
    // If Tonal triads missing, create names manually
    if (named.length < 6) {
      const degrees = (qual === "major")
        ? ["","m","m","","","m"]
        : ["m","dim","","m","m","",""];
      return scale.slice(0,6).map((n, i) => Note.pitchClass(n)+(degrees[i]||""));
    }
    return named.map(c => Chord.get(c).symbol);
  } catch {
    return [];
  }
}

function updateUI() {
  const chordBadge = document.getElementById("ytc-badge");
  const keyCell = document.getElementById("ytc-key");
  const chips = document.getElementById("ytc-diatonic");
  if (!chordBadge || !keyCell || !chips) return;

  const shownChord = applyTranspose(lastChord, transpose);
  chordBadge.textContent = shownChord || "--";
  keyCell.textContent = `Key: ${applyTranspose(lastKey?.replace(" major","").replace(" minor",""), transpose)} ${lastKey?.includes("minor")?"minor":"major"}`;

  chips.innerHTML = "";
  const diat = diatonicChords(lastKey).map(c => applyTranspose(c, transpose));
  for (const c of diat) {
    const span = document.createElement("span");
    span.className = "ytc-chip";
    span.textContent = c;
    chips.appendChild(span);
  }
}

function setStatus(msg) {
  const s = document.getElementById("ytc-status");
  if (s) s.textContent = msg;
}

function transposeSemis(n) {
  transpose += n;
  updateUI();
}

function suggestCapo() {
  // Suggest a capo (0–7) that makes I–V–vi–IV simplest (few sharps/flats) in the displayed transposed key.
  // Naive heuristic: choose transpose within [-6..+6] closest to C/G/D/A/E.
  const friendly = ["C","G","D","A","E"];
  const root = lastKey ? lastKey.split(" ")[0] : null;
  if (!root) return setStatus("Play the song so I can guess the key first.");
  let best = {shift:0, dist:9};
  const idx = PC.indexOf(root);
  for (let s=-6; s<=6; s++){
    const newRoot = PC[(idx + s + 1200)%12];
    const dist = friendly.includes(newRoot) ? 0 : 1;
    if (dist < best.dist) best = {shift:s, dist};
  }
  const capo = ((12 - best.shift) % 12) % 8; // simple mapping into 0..7
  setStatus(`Try capo ${capo} (or use transpose ${best.shift>=0?"+":""}${best.shift}).`);
}

// --- Audio setup ---
async function start() {
  await libsLoaded;
  ensureOverlay();
  if (running) return;
  const video = document.querySelector("video");
  if (!video) { setStatus("No video element found."); return; }

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  srcNode = audioCtx.createMediaElementSource(video);

  // Create a Meyda analyzer on the media element
  const bufferSize = 4096; // balance latency/accuracy
  if (!window.Meyda || !Meyda.createMeydaAnalyzer) {
    setStatus("Meyda failed to load."); return;
  }

  meydaAnalyzer = Meyda.createMeydaAnalyzer({
    audioContext: audioCtx,
    source: srcNode,
    bufferSize,
    featureExtractors: ["chroma"],
    callback: features => {
      const chroma = features.chroma || new Array(12).fill(0);
      // Smooth/normalize
      const sum = chroma.reduce((a,b)=>a+b,0) || 1;
      const norm = chroma.map(x=>x/sum);

      // Update rolling global chroma for key
      for (let i=0; i<12; i++) globalChroma[i] = 0.98*globalChroma[i] + 0.02*norm[i];

      // Estimate chord per frame and key from global
      lastChord = bestChord(norm);
      lastKey = bestKey(globalChroma);

      updateUI();
    }
  });

  // Connect to destination (so you still hear audio)
  srcNode.connect(audioCtx.destination);

  meydaAnalyzer.start();
  running = true;
  document.getElementById("ytc-start").disabled = true;
  document.getElementById("ytc-stop").disabled = false;
  setStatus("Listening… (hang tight a few seconds for key)");
}

function stop() {
  if (!running) return;
  try { meydaAnalyzer.stop(); } catch {}
  try { srcNode.disconnect(); } catch {}
  running = false;
  document.getElementById("ytc-start").disabled = false;
  document.getElementById("ytc-stop").disabled = true;
  setStatus("Stopped.");
}

function init() {
  ensureOverlay();
  setStatus("Ready. Press Start during a song.");
}

// Initialize on ready states / SPA navigation
let initOnce = false;
const onReady = () => { if (!initOnce) { initOnce = true; init(); } };
if (document.readyState === "complete" || document.readyState === "interactive") onReady();
else document.addEventListener("DOMContentLoaded", onReady);

// Also re-attach when YouTube changes page via SPA
const obs = new MutationObserver(() => ensureOverlay());
obs.observe(document.documentElement, {childList: true, subtree: true});
