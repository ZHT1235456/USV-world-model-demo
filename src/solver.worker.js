import * as ort from 'onnxruntime-web/wasm';
import loader from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import wasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import { historyLength } from './mission.js';
import { featureCount, imageHeight, imageWidth, VisualHistory } from './optics.js';
import { entryAligned, searchPlans } from './planner.js';
import { RaftTrack } from './raft-vision.js';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = {
  mjs: new URL(loader, import.meta.url).href,
  wasm: new URL(wasm, import.meta.url).href,
};

let course;
let history;
let track;
let avoidanceSide = 0;
let entrySide = 0;
let stage = 0;
let observer;
let motion;

async function initialize(urls) {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  observer = await ort.InferenceSession.create(urls.observer, options);
  motion = await ort.InferenceSession.create(urls.motion, options);
}

async function transition(state, command, batch) {
  const result = await motion.run({
    state: new ort.Tensor('float32', state, [batch, 8]),
    cmd: new ort.Tensor('float32', command, [batch, 2]),
  });
  return result.next.data;
}

async function estimate() {
  if (history.items.length < historyLength) throw new Error('前视窗口尚未采满');
  const features = new Float32Array(historyLength * featureCount);
  const size = imageHeight * imageWidth * 3;
  const pixels = new Uint8Array(historyLength * size);
  for (const [i, item] of history.items.entries()) {
    pixels.set(item.image, i * size);
    features.set(item.feature, i * featureCount);
  }
  const feeds = { history: new ort.Tensor('float32', features, [1, historyLength, featureCount]) };
  if (observer.inputNames.includes('pixels')) {
    feeds.pixels = new ort.Tensor('uint8', pixels, [1, historyLength, imageHeight, imageWidth, 3]);
  }
  const result = await observer.run(feeds);
  const state = result.state.data;
  const nextMark = course.marks[stage];
  if (nextMark && state[0] > nextMark.north + 0.38
    && (state[1] - nextMark.east) * nextMark.side > 0) stage++;
  return state;
}

async function handle(data) {
  const { type, id } = data;
  try {
    if (type === 'observe') {
      history.append(data.rgb, data.command, data.time);
      track.observe(data.rgb, history.pose, data.time);
      return;
    }
    let result;
    if (type === 'initialize') await initialize(data.urls);
    if (type === 'reset') {
      course = data.course;
      history = new VisualHistory(course);
      track = new RaftTrack();
      avoidanceSide = 0;
      entrySide = 0;
      stage = 0;
    }
    if (type === 'plan') {
      const started = performance.now();
      const state = await estimate();
      const { count, guideCount = 0, quality } = history.pose;
      if (entrySide && entryAligned(state[2])) entrySide = 0;
      const reverseEntry = stage === 0 && state[0] < course.marks[0].north - 2 && quality > 0 && Math.cos(state[2]) < 0;
      const turns = entrySide ? [entrySide] : reverseEntry ? [-1, 1] : [0];
      result = await searchPlans(state, transition, course, stage, track.position, avoidanceSide, turns);
      entrySide = result.entrySide;
      result.fix = { count, guideCount, quality };
      if (track.position) {
        avoidanceSide = result.avoidanceSide;
        result.obstruction = track.position;
      }
      result.observationTime = history.time;
      result.compute = performance.now() - started;
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};
