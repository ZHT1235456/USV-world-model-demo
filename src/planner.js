import { courseRoute, decisionStep, gateClearance, horizon, hullClearance, minimumClearance, predictedState, referenceEast, referenceRPM, referenceRudder, shoreClearance, wrapAngle } from './mission.js';
import { clamp } from './simulation.js';

const rudderBiases = [0, -7, 7, -14, 14];
const throttleBiases = [0, -135, 115];
const recoveryRPMs = [780, 910, 1080];
const turnClearance = 0.9;

export function entryRecovered(state, side) {
  const { heading, surge, sway } = state;
  const c = Math.cos(heading);
  const lateralSpeed = surge * Math.sin(heading) + sway * c;
  return c > 0.8 && side * wrapAngle(heading) > 0.22 && side * lateralSpeed > 0.06;
}

function point(state, step = 0) {
  return {
    north: state.north, east: state.east, heading: state.heading,
    speed: Math.hypot(state.surge, state.sway), seconds: step * decisionStep,
  };
}

function clearanceCost(candidate, state, previous, step, course, raft) {
  const { gate, marks } = course;
  const offset = state.east - referenceEast(state.north, candidate.route);
  candidate.cost += 0.037 * offset * offset;
  const shoreGap = shoreClearance(state, course);
  candidate.shoreGap = Math.min(candidate.shoreGap, shoreGap);
  const margin = candidate.entrySide ? turnClearance : minimumClearance;
  candidate.cost += 44 * Math.max(0, margin - shoreGap) ** 2;
  for (const mark of marks) {
    if (Math.abs(mark.north - state.north) > 6) continue;
    const gap = hullClearance(state, mark);
    if (gap < candidate.gap) {
      candidate.gap = gap;
      candidate.closest = { mark: mark.id, step, gap };
    }
    const deficit = Math.max(0, 0.77 - gap);
    candidate.cost += 25 * deficit * deficit;
    if (previous.north < mark.north && state.north >= mark.north
      && (state.east - mark.east) * mark.side <= 0) candidate.cost += 35;
  }
  if (raft && Math.abs(raft.north - state.north) < 6) {
    const gap = hullClearance(state, raft);
    candidate.gap = Math.min(candidate.gap, gap);
    candidate.cost += 37 * Math.max(0, 0.87 - gap) ** 2;
    if (previous.north < raft.north && state.north >= raft.north
      && (state.east - raft.east) * candidate.side <= 0) candidate.cost += 38;
  }
  if (previous.north < gate.north && state.north >= gate.north) {
    candidate.cost += 24 * Math.max(0, 0.18 - gateClearance(state, gate)) ** 2;
    if (gate.speed !== null) {
      candidate.cost += 65 * Math.max(0, Math.hypot(state.surge, state.sway) - gate.speed + 0.05) ** 2;
    }
  }
}

export async function searchPlans(initial, transition, course, activeMark, raft, committedSide, entryTurns = [0]) {
  const turning = entryTurns[0] !== 0;
  const steps = turning ? Math.round(14 / decisionStep) : horizon;
  const steering = turning ? [0] : rudderBiases;
  const throttles = turning ? recoveryRPMs : throttleBiases;
  const sides = raft ? (committedSide ? [committedSide] : [-1, 1]) : [0];
  const candidates = sides.flatMap((side) => {
    const route = courseRoute(course, raft, side);
    return entryTurns.flatMap((entrySide) => throttles.flatMap((throttle) => steering.map((bias) => ({
      route, side, entrySide, throttle, bias, recovering: turning,
      trajectory: [], command: null, closest: null, gap: Infinity, shoreGap: Infinity,
      cost: turning ? 0 : 0.30 * (bias / 14) ** 2 + 0.46 * (throttle / 135) ** 2,
    }))));
  });
  const count = candidates.length;
  let states = new Float32Array(count * 8);
  const commands = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    states.set(initial, i * 8);
    candidates[i].trajectory.push(point(predictedState(initial)));
  }
  for (let step = 0; step < steps; step++) {
    for (let i = 0; i < count; i++) {
      const candidate = candidates[i];
      const previous = predictedState(states, i * 8);
      const ramp = Math.max(0, 1 - step / 4);
      if (candidate.recovering && entryRecovered(previous, candidate.entrySide)) candidate.recovering = false;
      const facing = Math.cos(previous.heading);
      const commanded = candidate.recovering && facing < 0.35
        ? 35 * candidate.entrySide : referenceRudder(previous, candidate.route) + candidate.bias * ramp;
      const rudder = clamp(commanded, -35, 35);
      // Use propeller thrust to start the turn, then let the boat shed speed before the outside of the arc.
      const turningPower = clamp((0.47 - facing) / 0.12, 0, 1);
      const rpm = candidate.recovering ? candidate.throttle + (2100 - candidate.throttle) * turningPower
        : referenceRPM(previous, course.gate, turning ? 1800 : 1800 + candidate.throttle);
      commands[i * 2] = rpm;
      commands[i * 2 + 1] = rudder;
      if (step === 0) candidate.command = { rpm, rudder };
      candidate.cost += 0.018 * (rudder / 35) ** 2;
    }
    const predicted = await transition(states, commands, count);
    for (let i = 0; i < count; i++) {
      const candidate = candidates[i];
      const next = predictedState(predicted, i * 8);
      clearanceCost(candidate, next, predictedState(states, i * 8), step + 1, course, raft);
      if (step < horizon) candidate.trajectory.push(point(next, step + 1));
    }
    states = predicted;
  }
  for (const [i, candidate] of candidates.entries()) {
    const end = predictedState(states, i * 8);
    candidate.cost -= 0.17 * (end.north - initial[0]);
    candidate.cost += 0.10 * (end.east - referenceEast(end.north, candidate.route)) ** 2;
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const inside = candidates.filter(({ shoreGap }) => shoreGap >= minimumClearance);
  const best = inside.find(({ shoreGap, gap }) => shoreGap >= (turning ? turnClearance : minimumClearance) && gap >= minimumClearance)
    ?? inside.find(({ gap }) => gap >= minimumClearance)
    ?? inside[0]
    ?? candidates.reduce((safest, candidate) => candidate.shoreGap > safest.shoreGap ? candidate : safest);
  return {
    trajectory: best.trajectory,
    options: count,
    command: best.command,
    closest: best.closest,
    activeMark: course.marks[activeMark]?.id ?? null,
    maneuver: best.entrySide ? 'turn-entry' : raft && initial[0] < raft.north + 2.7 ? (best.side < 0 ? 'avoid-port' : 'avoid-starboard')
      : course.gate.speed !== null && initial[0] > course.gate.north - 11 ? 'gate' : null,
    avoidanceSide: best.side,
    entrySide: best.entrySide,
    estimated: point(predictedState(initial)),
  };
}
