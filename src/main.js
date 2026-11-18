import './style.css';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { HarborScene } from './harbor.js';
import { decisionTicks, fixedStep, frameTicks, MissionProgress, passedMark, startTrial } from './mission.js';
import { placeRaft, playableCourses } from './courses.js';
import { sensorHeight, sensorWidth } from './optics.js';
import { PlannerClient } from './planner-client.js';
import { detectBuoys, paintVisionOverlay } from './vision-overlay.js';
import { detectRaft } from './raft-vision.js';

const element = (id) => document.getElementById(id);
const stage = element('stage');
const startButton = element('start');
const resetButton = element('reset');
const replayButton = element('replay');
const scrubber = element('timeline');
const coursePicker = element('course');
const departurePicker = element('departure');
const sensor = element('sensor').getContext('2d', { alpha: false });
const sensorImage = sensor.createImageData(sensorWidth, sensorHeight);
const analysisCanvas = element('analysis');
const analysisStatus = element('analysis-status');
const notification = element('run-notification');
const views = Array.from(document.querySelectorAll('[data-view]'));
const asset = (path) => new URL(path, document.baseURI).href;

let scene;
let client;
let course = playableCourses[0];
let voyageSeed = 0;
let trial;
let progress;
let phase = 'loading';
let prediction;
let latestFrame;
let lastPainted;
let lastAnalysisPlan;
let sensorFlight;
let waiting = false;
let generation = 0;
let trace = [];
let history = [];
let lookAtTime = null;
let replay = false;
let lastFrame = performance.now();
let pendingTime = 0;
let failure = '';
let cursor = null;
let ghost = null;
let closest = null;
let frameDrawn = false;

function setPhase(next) {
  phase = next;
  document.body.dataset.phase = next;
}

function copyProgress() {
  return progress.gates.map((gate) => ({ ...gate }));
}

function paintSensor(frame, plan) {
  if (!frame || (frame === lastPainted && plan === lastAnalysisPlan)) return;
  if (frame !== lastPainted) {
    const { rgb, time } = frame;
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      sensorImage.data[j] = rgb[i];
      sensorImage.data[j + 1] = rgb[i + 1];
      sensorImage.data[j + 2] = rgb[i + 2];
      sensorImage.data[j + 3] = 255;
    }
    sensor.putImageData(sensorImage, 0, 0);
    element('sensor-clock').textContent = time >= 0 ? time.toFixed(2) + ' s' : '待命';
  }
  if (!frame.detections) {
    frame.detections = detectBuoys(frame.rgb);
    const raft = detectRaft(frame.rgb);
    if (raft) frame.detections.push(raft.box);
  }
  const orders = { 'avoid-port': '浮排左侧绕行', 'avoid-starboard': '浮排右侧绕行', gate: '减速穿门' };
  const hasRaft = frame.detections.some(({ id }) => id === 'raft');
  const count = frame.detections.filter(({ id }) => id !== 'raft').length;
  const turning = plan?.maneuver === 'turn-entry';
  const status = turning ? (plan.fix.guideCount ? '箭头定位 · 掉头' : '掉头中')
    : orders[plan?.maneuver] ?? (hasRaft ? '识别浮排' : count ? `识别 ${count} 标` : '未检出');
  if (analysisStatus.textContent !== status) analysisStatus.textContent = status;
  paintVisionOverlay(analysisCanvas, sensor.canvas, frame, plan);
  lastPainted = frame;
  lastAnalysisPlan = plan;
}

function errorState(error) {
  failure = error instanceof Error ? error.message : String(error);
  setPhase('error');
  waiting = false;
  element('model-dot').className = 'dot error';
  element('model-status').textContent = '模型运行出错';
  refresh();
}

function recordAt(time) {
  let selected = history[0];
  for (const record of history) {
    if (record.state.time > time + 0.0001) break;
    selected = record;
  }
  return selected;
}

function display() {
  const state = trial?.state;
  if (!state) return null;
  const now = Math.max(0, state.time);
  cursor = state;
  ghost = null;
  closest = null;
  let forecast = prediction;
  let analysisPlan = prediction;
  let read = latestFrame;
  let gates = progress.gates;
  let hint = '试航时间';
  let path = trace;

  if (lookAtTime !== null && history.length) {
    const last = history.at(-1);
    if (lookAtTime > last.state.time + 0.01 && last.prediction) {
      cursor = last.state;
      forecast = last.prediction;
      analysisPlan = last.prediction;
      const ahead = Math.max(0, lookAtTime - last.state.time);
      const index = Math.min(forecast.trajectory.length - 1, Math.round(ahead / 0.25));
      ghost = forecast.trajectory[index];
      read = last.frame;
      gates = last.gates;
      if (forecast.closest && Math.abs(index - forecast.closest.step) <= 1) closest = forecast.closest.mark;
      hint = '预测 +' + ahead.toFixed(2) + ' s';
    } else {
      const event = recordAt(lookAtTime);
      const previous = recordAt(event.state.time - 2.5);
      cursor = event.state;
      forecast = previous.prediction ?? event.prediction;
      analysisPlan = event.prediction;
      if (forecast) {
        const offset = Math.round((event.state.time - previous.state.time) / 0.25);
        ghost = forecast.trajectory[Math.min(forecast.trajectory.length - 1, Math.max(0, offset))];
      }
      path = trace.filter((p) => p.time <= cursor.time);
      read = event.frame;
      gates = event.gates;
      hint = '航次回放';
    }
  }
  return { forecast, analysisPlan, read, gates, hint, path, now };
}

function refresh() {
  const contents = display();
  const active = phase === 'running';
  const playable = phase === 'ready' || phase === 'paused' || phase === 'finished' || active;
  startButton.disabled = !playable;
  resetButton.disabled = phase === 'loading' || phase === 'preparing' || phase === 'error';
  coursePicker.disabled = !playable || active;
  departurePicker.disabled = coursePicker.disabled;
  replayButton.hidden = history.length < 2 || active || phase === 'preparing';
  replayButton.textContent = replay ? '暂停回放' : '回放';
  startButton.classList.toggle('playing', active);
  startButton.setAttribute('aria-label', active ? '暂停' : phase === 'paused' ? '继续' : phase === 'finished' ? '再跑一次' : '开始');
  const names = { loading: '载入', ready: '待命', preparing: '相机采样', running: '自主航行', paused: '暂停', finished: progress?.result?.success ? '出场完成' : '航次结束', error: '运行出错' };
  element('scene-state').textContent = replay ? '航次回放' : names[phase];
  notification.hidden = phase !== 'error' && phase !== 'finished';
  if (phase === 'error') {
    element('run-note').textContent = '无法继续试航';
    element('run-detail').textContent = failure;
  } else if (phase === 'finished') {
    element('run-note').textContent = progress.result.success ? '航次完成' : progress.result.reason;
    const clearance = Math.min(progress.raftClearance, ...progress.gates.map((gate) => gate.clearance));
    const stats = Number.isFinite(clearance) ? [`最小净距 ${clearance.toFixed(2)} m`] : [];
    if (progress.finish && course.gate.speed !== null) stats.push(`过门 ${progress.finish.speed.toFixed(2)} m/s`);
    element('run-detail').textContent = stats.join(' · ');
  }
  if (!contents) return;
  const { forecast, analysisPlan, gates, hint, path, read, now } = contents;
  const passed = gates.filter((gate, i) => passedMark(gate, course.marks[i])).length;
  element('course-progress').textContent = passed + ' / ' + course.marks.length;
  const lastDecision = history.at(-1)?.state.time ?? now;
  const max = Math.max(0.05, now, phase === 'finished' || !prediction ? now : lastDecision + 5);
  scrubber.disabled = history.length === 0 || phase === 'preparing';
  scrubber.max = max;
  scrubber.value = lookAtTime ?? now;
  scrubber.style.setProperty('--elapsed', Math.min(100, now / max * 100) + '%');
  element('time-mode').textContent = hint;
  element('time-value').textContent = (lookAtTime ?? now).toFixed(2).padStart(5, '0') + ' s';
  scene.paths(path, forecast?.trajectory ?? []);
  paintSensor(read, analysisPlan);
}

function initialVoyage() {
  const raft = placeRaft(course, voyageSeed);
  scene.configure(course, raft);
  trial = startTrial(course, voyageSeed, departurePicker.value === 'reverse' ? Math.PI : null);
  progress = new MissionProgress(trial.state, course, raft);
  trace = [];
  history = [];
  prediction = null;
  lookAtTime = null;
  replay = false;
  waiting = false;
  pendingTime = 0;
  cursor = trial.state;
  document.body.dataset.result = '';
  scene.conditions(voyageSeed);
  element('course-progress').title = '过标顺序 ' + course.marks.map(({ label }) => label).join(' → ');
  frameDrawn = false;
  latestFrame = { rgb: scene.sample(trial.state), time: -2 };
}

function observe(state, command, id) {
  const work = scene.sampleAsync(state).then((rgb) => {
    if (id !== generation) return;
    latestFrame = { rgb, time: state.time };
    client.observe(rgb.slice(), command, state.time);
    if (lookAtTime === null) paintSensor(latestFrame, prediction);
  }).catch((error) => {
    if (id === generation) errorState(error);
  });
  sensorFlight = work;
  work.finally(() => {
    if (sensorFlight === work) sensorFlight = null;
  });
  return work;
}

async function decide(id) {
  waiting = true;
  try {
    await sensorFlight;
    if (id !== generation || phase === 'error') return;
    const result = await client.request('plan');
    if (id !== generation || phase === 'error') return;
    prediction = result;
    trial.command = result.command;
    history.push({ state: { ...trial.state }, prediction, frame: latestFrame, gates: copyProgress() });
    refresh();
  } catch (error) {
    if (id === generation) errorState(error);
  } finally {
    if (id === generation) waiting = false;
  }
}

async function begin() {
  const id = ++generation;
  if (phase === 'finished') voyageSeed++;
  setPhase('preparing');
  refresh();
  try {
    await sensorFlight;
    if (id !== generation) return;
    initialVoyage();
    setPhase('preparing');
    refresh();
    await client.request('reset', { course });
    while (trial.ticks < 0 && id === generation && phase === 'preparing') {
      trial.step();
      if (trial.ticks % frameTicks === 0) await observe({ ...trial.state }, { ...trial.command }, id);
    }
    if (id !== generation || phase === 'error') return;
    trace.push({ ...trial.state });
    await decide(id);
    if (id !== generation || phase === 'error') return;
    setPhase('running');
    refresh();
  } catch (error) {
    if (id === generation) errorState(error);
  }
}

async function resetVoyage(next = course) {
  const id = ++generation;
  setPhase('preparing');
  refresh();
  try {
    await sensorFlight;
    if (id !== generation) return;
    if (course !== next) voyageSeed = 0;
    course = next;
    initialVoyage();
    setPhase('ready');
    refresh();
  } catch (error) {
    if (id === generation) errorState(error);
  }
}

function tick(delta) {
  if (phase !== 'running' || waiting) {
    pendingTime = Math.min(pendingTime, fixedStep);
    return;
  }
  pendingTime += Math.min(0.064, delta / 1000);
  while (pendingTime >= fixedStep && !waiting && phase === 'running') {
    pendingTime -= fixedStep;
    trial.step();
    progress.update(trial.state);
    if (trial.ticks % frameTicks === 0) {
      trace.push({ ...trial.state });
      if (!sensorFlight) observe({ ...trial.state }, { ...trial.command }, generation);
    }
    if (progress.result) {
      trace.push({ ...trial.state });
      history.push({ state: { ...trial.state }, prediction, frame: latestFrame, gates: copyProgress() });
      document.body.dataset.result = progress.result.success ? 'success' : 'failed';
      setPhase('finished');
      refresh();
    } else if (trial.ticks % decisionTicks === 0) {
      void decide(generation);
    }
  }
}

function animate(time) {
  const dt = time - lastFrame;
  lastFrame = time;
  tick(dt);
  if (replay && history.length) {
    lookAtTime = Math.min(history.at(-1).state.time, lookAtTime + Math.min(dt / 1000, 0.1));
    if (lookAtTime >= history.at(-1).state.time) replay = false;
    refresh();
  }
  if (scene && trial) {
    const visible = lookAtTime === null ? trial.state : cursor;
    scene.draw(visible, ghost, !frameDrawn, closest);
    frameDrawn = true;
  }
  requestAnimationFrame(animate);
}

function bindControls() {
  startButton.addEventListener('click', () => {
    if (phase === 'running') {
      setPhase('paused');
      refresh();
    } else if (phase === 'paused') {
      replay = false;
      lookAtTime = null;
      setPhase('running');
      refresh();
    } else if (phase === 'ready' || phase === 'finished') void begin();
  });
  resetButton.addEventListener('click', () => void resetVoyage());
  for (const item of playableCourses) coursePicker.add(new Option(item.title, item.id));
  coursePicker.value = course.id;
  coursePicker.addEventListener('change', () => {
    const next = playableCourses.find(({ id }) => id === coursePicker.value);
    if (next) void resetVoyage(next);
  });
  departurePicker.addEventListener('change', () => void resetVoyage());
  replayButton.addEventListener('click', () => {
    if (history.length < 2) return;
    replay = !replay;
    if (replay && (lookAtTime === null || lookAtTime >= history.at(-1).state.time)) lookAtTime = 0;
    refresh();
  });
  scrubber.addEventListener('input', () => {
    if (phase === 'running') setPhase('paused');
    replay = false;
    lookAtTime = Number(scrubber.value);
    refresh();
  });
  for (const button of views) {
    button.addEventListener('click', () => {
      scene.setView(button.dataset.view);
      for (const other of views) other.setAttribute('aria-pressed', String(other === button));
    });
  }
  if (!isTauri()) return;
  const window = getCurrentWindow();
  const button = element('fullscreen');
  const label = element('fullscreen-label');
  button.hidden = false;
  let changing = false;
  const update = async () => {
    label.textContent = await window.isFullscreen() ? '窗口模式' : '全屏';
  };
  const toggle = async () => {
    if (changing) return;
    changing = true;
    try {
      await window.setFullscreen(!(await window.isFullscreen()));
      await update();
    } catch (error) {
      console.error('窗口模式切换失败', error);
    } finally {
      changing = false;
    }
  };
  button.addEventListener('click', toggle);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F11' || event.repeat) return;
    event.preventDefault();
    void toggle();
  });
  void update().catch(console.error);
}

async function boot() {
  try {
    scene = new HarborScene(stage);
    initialVoyage();
    new ResizeObserver(() => {
      if (lastPainted) paintVisionOverlay(analysisCanvas, sensor.canvas, lastPainted, lastAnalysisPlan);
    }).observe(analysisCanvas);
    bindControls();
    refresh();
    requestAnimationFrame(animate);
    client = new PlannerClient({ observer: asset('models/observer.onnx'), motion: asset('models/motion.onnx') });
    await client.ready;
    element('model-status').textContent = '共享视觉模型就绪';
    element('model-dot').className = 'dot ready';
    setPhase('ready');
    refresh();
  } catch (error) {
    errorState(error);
  }
}

void boot()
