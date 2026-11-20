import { SeaTrial, clamp, degrees, fixedStep } from './simulation.js';
import { gatePostRadius, randomSource } from './courses.js';

export { fixedStep, randomSource };
export const frameTicks = 6;
export const decisionTicks = 15;
export const historyLength = 20;
export const horizon = 20;
export const decisionStep = decisionTicks * fixedStep;
export const minimumClearance = 0.5;
const hullHalfLength = 1.2;
const hullHalfBeam = 0.45;
const startBoundary = -9;

export function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function startTrial(course, seed = 0, departureOffset = null) {
  const trial = new SeaTrial();
  const random = randomSource(seed * 173 + 171);
  const nominalHeading = seed ? (random() - 0.5) * 0.18 : 0;
  const surge = seed ? 1.7 + random() * 0.35 : 1.893;
  const rpm = seed ? 1580 + random() * 330 : 1800;
  const north = seed ? (random() - 0.5) * 0.95 : 0;
  const east = course.center + (seed ? (random() - 0.5) * 1.05 : 0);
  const heading = departureOffset === null ? nominalHeading
    : wrapAngle(Math.atan2(course.gate.east - east, course.gate.north - north) + departureOffset);
  const preroll = historyLength * frameTicks * fixedStep;
  trial.ticks = -historyLength * frameTicks;
  Object.assign(trial.state, {
    time: -preroll,
    north: north - surge * preroll * Math.cos(heading),
    east: east - surge * preroll * Math.sin(heading),
    heading, surge, rpm,
  });
  trial.command = { rpm, rudder: 0 };
  trial.track = [];
  return trial;
}

export function stateVector(s) {
  return [s.north, s.east, s.heading, s.surge, s.sway, s.yawRate, s.rpm, s.rudder];
}

export function predictedState(array, offset = 0) {
  const [north, east, heading, surge, sway, yawRate, rpm, rudder] = array.subarray(offset, offset + 8);
  return { north, east, heading, surge, sway, yawRate, rpm, rudder };
}

export function courseRoute(course, obstruction = null, side = 0) {
  const stations = [
    { north: 0, east: course.center },
    ...course.marks.map((mark) => ({ north: mark.north, east: mark.east + 2.35 * mark.side })),
  ];
  const gate = course.gate;
  if (obstruction && side) {
    const previous = stations.at(-1);
    const north = Math.max(previous.north + 3, Math.min(gate.north - 8.5, obstruction.north));
    const east = obstruction.east + side * (obstruction.radius + 1.53);
    stations.push({ north: north - 1, east });
  }
  stations.push({ north: gate.north - (gate.speed === null ? 0.35 : 3.2), east: gate.east });
  return stations;
}

export function referenceEast(north, stations) {
  const index = stations.findIndex((station) => station.north >= north);
  if (index < 0) return stations.at(-1).east;
  if (index === 0) return stations[0].east;
  const from = stations[index - 1], to = stations[index];
  const amount = 0.5 - 0.5 * Math.cos(Math.PI * (north - from.north) / (to.north - from.north));
  return from.east + amount * (to.east - from.east);
}

export function referenceRudder(s, route) {
  const lookAhead = clamp(2.45 + 0.72 * s.surge, 1.7, 5);
  const desired = Math.atan2(referenceEast(s.north + lookAhead, route) - s.east, lookAhead);
  const headingError = degrees(wrapAngle(desired - s.heading));
  return clamp(2.85 * headingError - 0.60 * degrees(s.yawRate), -35, 35);
}

export function referenceRPM(state, gate, cruise = 1800) {
  if (gate.speed === null) return cruise;
  const ramp = clamp((gate.north - state.north - 4.5) / 4.5, 0, 1);
  return 790 + (cruise - 790) * ramp;
}

export function collectionCommand(s, seed, course, route) {
  const random = randomSource(seed * 7727 + 231);
  const rpm = 1550 + random() * 420;
  const phase = random() * 6.283;
  const amplitude = 3 + random() * 14;
  const offset = Math.sin(s.time * 0.87 + phase) * amplitude;
  const explore = seed % 6 === 0;
  const steering = explore && s.time > 3 && s.time < 9
    ? offset
    : referenceRudder(s, route) + offset;
  return {
    rpm: clamp(referenceRPM(s, course.gate, rpm) + 125 * Math.sin(s.time * 0.52 + phase), 500, 2100),
    rudder: clamp(steering, -35, 35),
  };
}

export function hullClearance(s, mark) {
  const north = mark.north - s.north;
  const east = mark.east - s.east;
  const c = Math.cos(s.heading);
  const d = Math.sin(s.heading);
  const along = north * c + east * d;
  const across = -north * d + east * c;
  return Math.hypot(Math.max(0, Math.abs(along) - hullHalfLength), Math.max(0, Math.abs(across) - hullHalfBeam)) - mark.radius;
}

export function gateClearance(state, gate) {
  const width = hullHalfLength * Math.abs(Math.sin(state.heading)) + hullHalfBeam * Math.abs(Math.cos(state.heading));
  return gate.halfWidth - gatePostRadius - width - Math.abs(state.east - gate.east);
}

export function shoreClearance(state, course) {
  const c = Math.abs(Math.cos(state.heading)), s = Math.abs(Math.sin(state.heading));
  const side = course.bank - Math.abs(state.east - course.center) - hullHalfLength * s - hullHalfBeam * c;
  const rear = state.north - startBoundary - hullHalfLength * c - hullHalfBeam * s;
  return Math.min(side, rear);
}

export function passedMark(crossing, mark) {
  return crossing.crossing !== null && crossing.crossing * mark.side > 0 && crossing.clearance >= minimumClearance;
}

export class MissionProgress {
  constructor(state, course, raft) {
    this.last = { ...state };
    this.course = course;
    this.raft = raft;
    this.raftClearance = Infinity;
    this.raftCrossing = null;
    this.shoreClearance = Infinity;
    this.finish = null;
    this.gates = course.marks.map(() => ({ clearance: Infinity, crossing: null }));
    this.result = null;
  }

  update(s) {
    if (this.result) return;
    const { marks, gate: exit } = this.course;
    this.shoreClearance = Math.min(this.shoreClearance, shoreClearance(s, this.course));
    if (this.shoreClearance <= 0) {
      this.result = { success: false, reason: '艇身触碰航道边界' };
      return;
    }
    const crossingAt = (north) => this.last.north < north && s.north >= north;
    const interpolate = (north, key) => this.last[key] + (s[key] - this.last[key])
      * (north - this.last.north) / (s.north - this.last.north);
    for (const [i, mark] of marks.entries()) {
      const gate = this.gates[i];
      gate.clearance = Math.min(gate.clearance, hullClearance(s, mark));
      if (gate.crossing === null && crossingAt(mark.north)) gate.crossing = interpolate(mark.north, 'east') - mark.east;
    }
    if (this.raft) {
      this.raftClearance = Math.min(this.raftClearance, hullClearance(s, this.raft));
      if (this.raftCrossing === null && crossingAt(this.raft.north)) {
        this.raftCrossing = interpolate(this.raft.north, 'east') - this.raft.east;
      }
    }
    if (crossingAt(exit.north)) {
      const east = interpolate(exit.north, 'east');
      const speed = Math.hypot(interpolate(exit.north, 'surge'), interpolate(exit.north, 'sway'));
      const clearance = gateClearance({ east, heading: interpolate(exit.north, 'heading') }, exit);
      this.finish = { speed, clearance, east };
      let reason = '';
      if (!this.gates.every((gate, i) => passedMark(gate, marks[i]))) reason = '过标侧或净距未达标';
      else if (this.raft && this.raftClearance < minimumClearance) reason = '浮排净距未达标';
      else if (clearance < 0) reason = '偏离出场门';
      else if (exit.speed !== null && speed > exit.speed) reason = '过门速度超限';
      this.result = { success: !reason, reason: reason || '通过出场门' };
    } else if (s.time >= 78) {
      this.result = { success: false, reason: '航次超时' };
    }
    this.last = { ...s };
  }
}
