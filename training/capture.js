import { HarborScene } from '../src/harbor.js';
import { VisualHistory } from '../src/optics.js';
import { collectionCommand, courseRoute, decisionTicks, fixedStep, frameTicks, horizon, MissionProgress, passedMark, referenceRudder, startTrial, stateVector, wrapAngle } from '../src/mission.js';
import { placeRaft, playableCourses, raftBand, randomSource, testCourses, trainingCourses } from '../src/courses.js';
import { clamp, SeaTrial } from '../src/simulation.js';
import { PlannerClient } from '../src/planner-client.js';

function encode(array) {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 24576) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 24576)));
  }
  return btoa(chunks.join(''));
}

function futures(original, seed, route, actions, labels) {
  const rng = randomSource(seed);
  for (let branch = 0; branch < 5; branch++) {
    const trial = new SeaTrial();
    trial.state = { ...original.state };
    trial.ticks = original.ticks;
    const rpm = 550 + rng() * 1560;
    const turn = 10 + rng() * 24;
    const release = 3 + Math.floor(rng() * 12);
    for (let step = 0; step < horizon; step++) {
      let rudder = 0;
      if (branch === 1) rudder = step < release ? turn : 0;
      if (branch === 2) rudder = step < release ? -turn : 0;
      if (branch === 3) rudder = clamp(referenceRudder(trial.state, route) + (rng() - 0.5) * 14, -35, 35);
      if (branch === 4) rudder = step < release ? (seed % 2 ? -turn : turn) : (seed % 2 ? turn : -turn);
      trial.command = { rpm, rudder };
      actions.push(rpm, rudder);
      for (let tick = 0; tick < decisionTicks; tick++) trial.step();
      labels.push(...stateVector(trial.state));
    }
  }
}

const scene = new HarborScene(null, true);

window.captureEpisode = (seed, seconds = 70, diagnostic = false) => {
  const courses = seed >= 3000 ? testCourses : trainingCourses;
  const course = courses[seed % courses.length];
  const raft = placeRaft(course, seed);
  const route = courseRoute(course, raft, seed % 2 ? -1 : 1);
  const departures = [null, null, Math.PI, Math.PI, Math.PI / 2, -Math.PI / 2];
  const angle = departures[Math.floor(seed / courses.length) % departures.length];
  const departure = angle === null ? 'forward' : angle === Math.PI ? 'reverse' : 'sideways';
  const jitter = (randomSource(seed * 5473 + 183)() - 0.5) * 0.36;
  const trial = startTrial(course, seed, angle === null ? null : angle + jitter);
  const history = new VisualHistory(course);
  scene.configure(course, raft);
  scene.conditions(seed);
  const frames = [];
  const features = [];
  const states = [];
  const samples = [];
  const actions = [];
  const futuresTruth = [];
  let valid = 0;
  let positionError = 0;
  let headingError = 0;
  let first;
  let sampleNo = 0;
  const start = performance.now();
  while (trial.ticks < Math.round(seconds / fixedStep)) {
    if (trial.ticks >= 0 && trial.ticks % decisionTicks === 0) {
      trial.command = collectionCommand(trial.state, seed, course, route);
    }
    trial.step();
    if (trial.ticks % frameTicks !== 0) continue;
    const rgb = scene.sample(trial.state);
    const { feature, image } = history.append(rgb, trial.command, trial.state.time);
    if (history.pose.quality > 0) {
      positionError += Math.hypot(history.pose.north - trial.state.north, history.pose.east - trial.state.east);
      headingError += Math.abs(wrapAngle(history.pose.heading - trial.state.heading));
      valid++;
    }
    if (diagnostic && (sampleNo === 19 || (!first && trial.state.time >= 0))) {
      first = {
        pixels: encode(rgb),
        measured: history.pose,
        state: { ...trial.state },
      };
    }
    frames.push(image);
    features.push(...feature);
    states.push(...stateVector(trial.state));
    if (sampleNo >= 19 && (sampleNo - 19) % 9 === 0) {
      samples.push(sampleNo);
      futures(trial, seed * 257 + sampleNo, route, actions, futuresTruth);
    }
    sampleNo++;
    if (trial.state.north > course.gate.north + 0.8 || Math.abs(trial.state.east - course.center) > course.bank) break;
  }
  const pixels = new Uint8Array(frames.length * frames[0].length);
  for (const [i, frame] of frames.entries()) pixels.set(frame, i * frame.length);
  return {
    seed, course: course.id, departure, count: frames.length, sampleCount: samples.length,
    frames: encode(pixels),
    features: encode(new Float32Array(features)),
    states: encode(new Float32Array(states)),
    samples: encode(new Int32Array(samples)),
    actions: encode(new Float32Array(actions)),
    futures: encode(new Float32Array(futuresTruth)),
    diagnostic: first,
    valid,
    positionError: positionError / Math.max(valid, 1),
    headingError: headingError / Math.max(valid, 1),
    elapsed: performance.now() - start,
  };
};

let client;

function withoutRaftBand(rgb) {
  const r = raftBand >> 16, g = (raftBand >> 8) & 255, b = raftBand & 255;
  for (let i = 0; i < rgb.length; i += 3) {
    if ((rgb[i] - r) ** 2 + (rgb[i + 1] - g) ** 2 + (rgb[i + 2] - b) ** 2 > 36) continue;
    rgb[i] = 70;
    rgb[i + 1] = 78;
    rgb[i + 2] = 83;
  }
  return rgb;
}

window.evaluateVoyage = async (seed, courseId, maskRaft = false, launch = {}) => {
  const course = [...playableCourses, ...trainingCourses].find(({ id }) => id === courseId);
  if (!course) throw new Error('Unknown evaluation course: ' + courseId);
  const getUrl = (path) => new URL(path, location.href).href;
  client ??= new PlannerClient({ observer: getUrl('../models/observer.onnx'), motion: getUrl('../models/motion.onnx') });
  await client.ready;
  await client.request('reset', { course });
  const trial = startTrial(course, seed, launch.reverse ? Math.PI : null);
  const raft = placeRaft(course, seed);
  const progress = new MissionProgress(trial.state, course, raft);
  const latencies = [];
  const computes = [];
  const poses = [];
  let lastObservation = 0;
  let firstDetection = null;
  let firstPlan = null;
  scene.configure(course, raft, !launch.maskGuides);
  scene.conditions(seed);
  while (!progress.result) {
    trial.step();
    progress.update(trial.state);
    if (trial.ticks % frameTicks === 0) {
      const rgb = scene.sample(trial.state);
      client.observe(maskRaft ? withoutRaftBand(rgb) : rgb, trial.command, trial.state.time);
      lastObservation = performance.now();
    }
    if (trial.ticks >= 0 && trial.ticks % decisionTicks === 0 && !progress.result) {
      const prediction = await client.request('plan');
      latencies.push(performance.now() - lastObservation);
      computes.push(prediction.compute);
      poses.push(Math.hypot(prediction.estimated.north - trial.state.north, prediction.estimated.east - trial.state.east));
      firstPlan ??= {
        heading: trial.state.heading * 180 / Math.PI,
        estimatedHeading: wrapAngle(prediction.estimated.heading) * 180 / Math.PI,
        headingError: Math.abs(wrapAngle(prediction.estimated.heading - trial.state.heading)) * 180 / Math.PI,
        anchors: prediction.fix.count, guidePoints: prediction.fix.guideCount,
        rudder: prediction.command.rudder,
      };
      if (prediction.obstruction && !firstDetection) {
        firstDetection = {
          seconds: trial.state.time, side: prediction.avoidanceSide,
          ahead: raft.north - trial.state.north,
          error: Math.hypot(prediction.obstruction.north - raft.north, prediction.obstruction.east - raft.east),
        };
      }
      trial.command = prediction.command;
    }
  }
  return {
    seed, course: course.id, ...progress.result, seconds: trial.state.time,
    marks: progress.gates.map((gate, i) => ({ id: course.marks[i].id, ...gate, passed: passedMark(gate, course.marks[i]) })),
    raft: raft ? { clearance: progress.raftClearance, crossing: progress.raftCrossing, detection: firstDetection } : null,
    finish: progress.finish, speedLimit: course.gate.speed, firstPlan, latencies, computes, poses,
  };
};
