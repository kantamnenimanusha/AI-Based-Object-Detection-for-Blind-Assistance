/* Blind Assist — Final Enhanced Version
   -------------------------------------
   ✅ Voice start/stop
   ✅ Object detection (useful/harmful only)
   ✅ Speaks object, direction & distance
   ✅ Alerts (beep + vibration) within 2 m
   ✅ Distance-based voice modulation
   ✅ Lag-free detection
   ✅ Auto-restart voice listener
*/

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const voiceStatus = document.getElementById('voiceStatus');
const modelStatus = document.getElementById('modelStatus');
const objectCountElem = document.getElementById('objectCount');
const alarmState = document.getElementById('alarmState');
const lastSpeechElem = document.getElementById('lastSpeech');

/* ---------- CONFIG ---------- */
const IMPORTANT_OBJECTS = new Set([
  'person', 'car', 'bus', 'truck', 'bicycle', 'motorcycle',
  'dog', 'cat', 'chair', 'bench', 'bottle', 'cup', 'door',
  'stairs', 'handbag', 'backpack', 'traffic light', 'stop sign',
  'fire hydrant', 'potted plant', 'tv', 'keyboard', 'cell phone'
]);

const MODEL_THRESHOLD = 0.3;  // lowered threshold to detect more
let CRITICAL_DISTANCE = 2.0;  // meters for alert
let ANNOUNCE_DISTANCE = 3.5;  // slightly longer detection range
const FRAME_INTERVAL = 350;   // smoother updates
let REFERENCE_WIDTH_PX = 160; // calibration defaults
let REFERENCE_REAL_WIDTH_M = 0.45;
let REFERENCE_DIST_M = 1.0;

/* ---------- STATE ---------- */
let model, stream, detecting = false;
let audioCtx, beepOsc;
let recognition;
let lastDetect = 0;
let lastSpeechTime = 0;
const SPEECH_GAP_MS = 1300;
let objectMemory = {};

/* ---------- UTILITIES ---------- */
function speak(text, rate = 1, pitch = 1) {
  if (!('speechSynthesis' in window)) return;
  const now = Date.now();
  if (now - lastSpeechTime < SPEECH_GAP_MS) return;
  lastSpeechTime = now;
  lastSpeechElem.textContent = text;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = rate;
  utter.pitch = pitch;
  window.speechSynthesis.speak(utter);
}

function estimateDistance(boxWidthPx) {
  if (!boxWidthPx || boxWidthPx <= 0) return 999;
  return (REFERENCE_WIDTH_PX / boxWidthPx) * REFERENCE_REAL_WIDTH_M * REFERENCE_DIST_M;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ---------- AUDIO / VIBRATION ---------- */
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function startBeep() {
  if (beepOsc) return;
  ensureAudio();
  beepOsc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  beepOsc.connect(gain);
  gain.connect(audioCtx.destination);
  gain.gain.value = 0;
  beepOsc.type = 'sine';
  beepOsc.start();
  beepOsc._gain = gain;
}
function updateBeep(freq = 900, vol = 0.08) {
  if (!beepOsc) startBeep();
  try {
    beepOsc.frequency.value = freq;
    beepOsc._gain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.05);
  } catch {}
}
function stopBeep() {
  if (!beepOsc) return;
  try {
    beepOsc._gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
    setTimeout(() => { try { beepOsc.stop(); } catch {}; beepOsc = null; }, 150);
  } catch {}
}

/* ---------- CAMERA & MODEL ---------- */
async function ensureModel() {
  if (model) return;
  modelStatus.textContent = 'Model: loading...';
  model = await cocoSsd.load();
  modelStatus.textContent = 'Model: ready';
}
async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = r);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

/* ---------- DETECTION ---------- */
async function detectOnce() {
  const now = Date.now();
  if (now - lastDetect < FRAME_INTERVAL) return null;
  lastDetect = now;
  try { return await model.detect(video); }
  catch (e) { console.error('Detection error:', e); return []; }
}

function drawBox(x, y, w, h, label, extra = '') {
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#00ff90';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y - 22, ctx.measureText(label).width + 60, 22);
  ctx.fillStyle = '#fff';
  ctx.font = '16px Arial';
  ctx.fillText(`${label} ${extra}`, x + 4, y - 6);
}

function clearOverlay() { ctx.clearRect(0, 0, canvas.width, canvas.height); }

async function detectionLoop() {
  while (detecting) {
    const predictions = await detectOnce();
    if (!predictions) { await new Promise(r => setTimeout(r, 50)); continue; }

    clearOverlay();
    let closeAlert = false;
    const results = predictions
      .filter(p => p.score >= MODEL_THRESHOLD && IMPORTANT_OBJECTS.has(p.class))
      .map(p => ({ ...p, distance: estimateDistance(p.bbox[2]) }))
      .sort((a, b) => a.distance - b.distance);

    objectCountElem.textContent = results.length;

    const speechBuffer = [];

    for (const obj of results) {
      const [x, y, w, h] = obj.bbox;
      const dist = obj.distance;
      drawBox(x, y, w, h, obj.class, dist < 999 ? `${dist.toFixed(1)}m` : '');

      if (dist <= ANNOUNCE_DISTANCE) {
        const pos = (x + w/2 < canvas.width/3) ? 'left' :
                    (x + w/2 > 2*canvas.width/3) ? 'right' : 'front';
        speechBuffer.push(`${obj.class} ${pos} at ${dist.toFixed(1)} meters`);
      }

      if ((obj.class === 'person' || ['car','bus','truck','motorcycle','bicycle'].includes(obj.class))
          && dist <= CRITICAL_DISTANCE) {
        closeAlert = true;
      }
    }

    if (speechBuffer.length > 0) {
      const nearest = speechBuffer.slice(0, 2).join(', ');
      const dist = results.length ? results[0].distance : 2;
      const pitch = clamp(1.6 - (dist / 4), 0.8, 1.5);
      const rate = clamp(1.2 - (dist / 8), 0.9, 1.3);
      speak(nearest, rate, pitch);
    }

    if (closeAlert) {
      alarmState.textContent = 'ALERT';
      alarmState.style.background = 'red';
      const nearest = results[0]?.distance || 1.5;
      const freq = clamp(1200 - (nearest * 250), 400, 2000);
      const vol = clamp(0.1 + ((CRITICAL_DISTANCE - nearest) / CRITICAL_DISTANCE) * 0.2, 0.04, 0.25);
      updateBeep(freq, vol);
      if (navigator.vibrate) navigator.vibrate([250, 100]);
      speak('Warning, object very near', 1.05, 1.3);
    } else {
      alarmState.textContent = 'SAFE';
      alarmState.style.background = 'green';
      stopBeep();
    }

    await new Promise(r => setTimeout(r, 50));
  }
}

/* ---------- CONTROL ---------- */
async function startDetection() {
  if (detecting) return;
  await ensureModel();
  await startCamera();
  detecting = true;
  speak('Detection started');
  detectionLoop();
}
function stopDetection() {
  if (!detecting) { speak('Already stopped'); return; }
  detecting = false;
  stopBeep();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
  clearOverlay();
  speak('Detection stopped');
}

/* ---------- VOICE CONTROL ---------- */
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    voiceStatus.textContent = 'Voice: not supported';
    speak('Voice not supported on this device');
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-IN';
  recognition.onstart = () => {
    voiceStatus.textContent = '🎤 Listening for commands...';
    speak('Voice ready. Say start detection or stop detection.');
  };
  recognition.onresult = (event) => {
    const cmd = event.results[event.results.length - 1][0].transcript.toLowerCase();
    voiceStatus.textContent = 'Heard: ' + cmd;
    if (cmd.includes('start')) startDetection();
    else if (cmd.includes('stop') || cmd.includes('pause')) stopDetection();
  };
  recognition.onend = () => { try { recognition.start(); } catch {} };
  recognition.start();
}

/* ---------- INIT ---------- */
(async function init() {
  ensureModel().catch(()=>{});
  initVoice();
})();
