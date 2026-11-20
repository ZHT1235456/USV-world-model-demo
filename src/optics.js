import { historyLength, wrapAngle } from './mission.js';

export const sensorWidth = 160;
export const sensorHeight = 96;
export const sensorFov = 62;
export const cameraForward = 0.052;
export const cameraHeight = 0.642;
export const imageWidth = 40;
export const imageHeight = 24;
export const featureCount = 12;

export const focal = sensorHeight / (2 * Math.tan(sensorFov * Math.PI / 360));

function beaconColor(index) {
  const hue = (index * 0.3727 + 0.025) % 1;
  return [5, 3, 1].map((offset) => {
    const sector = (offset + hue * 6) % 6;
    return Math.round(242 * (1 - 0.94 * Math.max(0, Math.min(sector, 4 - sector, 1))));
  });
}

export function chartBeacons(course) {
  const step = (course.gate.north + 5.75) / 7;
  return [
    ...[-1, 1].flatMap((side, bank) => Array.from({ length: 8 }, (_, i) => ({
      north: -0.5 + step * i, east: course.center + side * (course.bank - 0.25),
      height: 2.22 + (i % 2) * 0.27, rgb: beaconColor(bank * 8 + i),
    }))),
    ...[-5.3, -2.8, 2.8, 5.3].map((east, index) => ({
      north: course.gate.north + 8.3, east: course.center + east * course.bank / 8.9,
      height: 2.04 + (index % 2) * 0.35, rgb: beaconColor(16 + index),
    })),
  ];
}

// Keep the tail and tip codes within yellow while leaving enough RGB distance to tell them apart.
const guideColors = [187, 207, 227, 247].flatMap((red) =>
  [red - 4, red - 20].flatMap((green) => [30, 56, 82, 108].map((blue) => [red, green, blue])));

export function chartGuides(course) {
  const length = course.gate.north;
  const stations = [-13, -10.3, -3.6, 5, 0.33 * length, 0.60 * length, 0.84 * length];
  return [-1, 1].flatMap((side, bank) => stations.map((north, i) => {
    const east = course.center + side * (course.bank - 0.27);
    const height = 1.65;
    const code = 2 * (bank * stations.length + i);
    return { north, east, height, side, anchors: [
      { north: north - 0.79, east, height, rgb: guideColors[code], guide: true },
      { north: north + 0.60, east, height, rgb: guideColors[code + 1], guide: true },
    ] };
  }));
}

function solve3(matrix, rhs) {
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let j = 0; j < 3; j++) {
    let pivot = j;
    for (let i = j + 1; i < 3; i++) if (Math.abs(a[i][j]) > Math.abs(a[pivot][j])) pivot = i;
    if (Math.abs(a[pivot][j]) < 1e-8) return null;
    [a[pivot], a[j]] = [a[j], a[pivot]];
    const scale = a[j][j];
    for (let k = j; k < 4; k++) a[j][k] /= scale;
    for (let i = 0; i < 3; i++) {
      if (i === j) continue;
      const factor = a[i][j];
      for (let k = j; k < 4; k++) a[i][k] -= factor * a[j][k];
    }
  }
  return a.map((row) => row[3]);
}

function initialPose(points) {
  let sum = 0;
  let meanF = 0;
  let meanR = 0;
  let meanN = 0;
  let meanE = 0;
  for (const p of points) {
    sum += p.weight;
    meanF += p.forward * p.weight;
    meanR += p.right * p.weight;
    meanN += p.north * p.weight;
    meanE += p.east * p.weight;
  }
  meanF /= sum;
  meanR /= sum;
  meanN /= sum;
  meanE /= sum;
  let dot = 0;
  let cross = 0;
  for (const p of points) {
    const f = p.forward - meanF;
    const r = p.right - meanR;
    const n = p.north - meanN;
    const e = p.east - meanE;
    dot += p.weight * (f * n + r * e);
    cross += p.weight * (f * e - r * n);
  }
  const heading = Math.atan2(cross, dot);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return [meanN - c * meanF + s * meanR, meanE - s * meanF - c * meanR, heading];
}

function optimizePose(points, pose, course) {
  let error = 0;
  for (let iteration = 0; iteration < 5; iteration++) {
    const hessian = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]];
    const gradient = [0, 0, 0];
    const c = Math.cos(pose[2]);
    const s = Math.sin(pose[2]);
    let used = 0;
    error = 0;
    for (const p of points) {
      const n = p.north - pose[0];
      const e = p.east - pose[1];
      const forward = c * n + s * e;
      const right = -s * n + c * e;
      if (forward < 0.8) continue;
      const u = focal * right / forward;
      const v = focal * p.up / forward;
      const residual = [p.u - u, p.v - v];
      const magnitude = Math.hypot(...residual);
      const weight = Math.min(1, 1.4 / Math.max(magnitude, 1e-6)) * p.weight;
      const df = [-c, -s, right];
      const dr = [s, -c, -forward];
      const rows = [
        df.map((delta, i) => (focal * dr[i] - u * delta) / forward),
        df.map((delta) => -v * delta / forward),
      ];
      for (let axis = 0; axis < 3; axis++) {
        gradient[axis] += weight * (rows[0][axis] * residual[0] + rows[1][axis] * residual[1]);
        for (let j = 0; j < 3; j++) {
          hessian[axis][j] += weight * (rows[0][axis] * rows[0][j] + rows[1][axis] * rows[1][j]);
        }
      }
      used++;
      error += magnitude * magnitude;
    }
    if (used < 2) return null;
    error = Math.sqrt(error / used);
    const delta = solve3(hessian, gradient);
    if (!delta) return null;
    const scale = Math.min(1, 2.5 / Math.max(0.001, Math.hypot(delta[0], delta[1])), 0.35 / Math.max(0.001, Math.abs(delta[2])));
    pose = pose.map((v, i) => v + delta[i] * scale);
  }
  if (error > 1.65 || pose[0] < -12 || pose[0] > course.gate.north + 15
    || Math.abs(pose[1] - course.center) > course.bank + 1.6) return null;
  const heading = wrapAngle(pose[2]);
  return {
    north: pose[0] - cameraForward * Math.cos(heading),
    east: pose[1] - cameraForward * Math.sin(heading),
    heading,
    quality: Math.min(1, points.length / 4) / (1 + error),
    count: points.length,
    guideCount: points.filter(({ guide }) => guide).length,
  };
}

function beaconCenters(rgb, beacons) {
  const colors = beacons.map(() => ({ count: 0, x: 0, y: 0 }));
  for (let y = 0; y < sensorHeight / 2; y++) {
    for (let x = 0; x < sensorWidth; x++) {
      const i = (y * sensorWidth + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const low = Math.min(r, g, b);
      const high = Math.max(r, g, b);
      const guidePixel = r >= 180 && g >= 160 && Math.abs(r - g) <= 30 && b >= 23 && b <= 115;
      if (!guidePixel && (high < 219 || low > 49)) continue;
      let best = -1;
      let error = guidePixel ? 7 * 7 : 22 * 22;
      for (let j = 0; j < beacons.length; j++) {
        if (Boolean(beacons[j].guide) !== guidePixel) continue;
        const signature = beacons[j].rgb;
        const delta = (r - signature[0]) ** 2 + (g - signature[1]) ** 2 + (b - signature[2]) ** 2;
        if (delta < error) {
          error = delta;
          best = j;
        }
      }
      if (best !== -1) {
        const color = colors[best];
        color.count++;
        color.x += x + 0.5;
        color.y += y + 0.5;
      }
    }
  }
  return colors.map(({ count, x, y }) => {
    if (count < 2) return null;
    x /= count;
    y /= count;
    return x < 2 || x > sensorWidth - 2 || y > sensorHeight / 2 - 2 || count > 260 ? null : { x, y, count };
  });
}

export function detectGuideDirection(rgb, anchors) {
  const centers = beaconCenters(rgb, anchors);
  let direction = null;
  // Each sign has a uniquely colored tail and tip, in that order in chartGuides.
  for (let i = 0; i < centers.length; i += 2) {
    const tail = centers[i], tip = centers[i + 1];
    if (!tail || !tip || Math.hypot(tip.x - tail.x, tip.y - tail.y) < 2.5) continue;
    const support = Math.min(tail.count, tip.count);
    if (!direction || support > direction.support) direction = { tail, tip, support };
  }
  return direction;
}

export function poseFromFrame(rgb, beacons, course) {
  const points = beaconCenters(rgb, beacons).flatMap((center, i) => {
    if (!center) return [];
    const { x, y, count } = center;
    const u = x - sensorWidth / 2;
    const v = sensorHeight / 2 - y;
    const anchor = beacons[i];
    const up = anchor.height - cameraHeight;
    const forward = focal * up / v;
    const right = u * forward / focal;
    return [{ ...anchor, u, v, up, forward, right, weight: Math.min(3, Math.sqrt(count) * 0.37) }];
  });
  if (points.length < 2) return null;
  return optimizePose(points, initialPose(points), course);
}

export function shrinkFrame(rgb) {
  const reduced = new Uint8Array(3 * imageWidth * imageHeight);
  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      const position = (y * imageWidth + x) * 3;
      const source = ((y * 4 + 1) * sensorWidth + x * 4 + 1) * 3;
      const lower = source + sensorWidth * 3;
      for (let channel = 0; channel < 3; channel++) {
        reduced[position + channel] = Math.round((rgb[source + channel] + rgb[source + 3 + channel]
          + rgb[lower + channel] + rgb[lower + 3 + channel]) / 4);
      }
    }
  }
  return reduced;
}

function regression(samples) {
  const count = samples.length;
  if (count < 2) return [0, 0, 0];
  const base = samples[0];
  const totals = [0, 0, 0];
  const cross = [0, 0, 0];
  let time = 0;
  let squared = 0;
  for (const pose of samples) {
    const dt = pose.time - base.time;
    const offset = [pose.north - base.north, pose.east - base.east, wrapAngle(pose.heading - base.heading)];
    for (let i = 0; i < 3; i++) {
      totals[i] += offset[i];
      cross[i] += offset[i] * dt;
    }
    time += dt;
    squared += dt * dt;
  }
  const divider = squared - time * time / count;
  return cross.map((v, i) => (v - time * totals[i] / count) / Math.max(divider, 1e-6));
}

export class VisualHistory {
  constructor(course) {
    this.course = course;
    this.beacons = [...chartBeacons(course), ...chartGuides(course).flatMap(({ anchors }) => anchors)];
    this.items = [];
    this.measurements = [];
    this.pose = null;
    this.rpm = 1800;
    this.rudder = 0;
    this.shifts = [0, 0, 0];
    this.time = null;
  }

  append(rgb, command, time) {
    const first = this.time === null;
    const dt = first ? 0.1 : Math.max(0.001, time - this.time);
    if (first) {
      this.rpm = command.rpm;
      this.rudder = command.rudder;
    } else {
      this.rpm += (command.rpm - this.rpm) * (1 - Math.exp(-dt / 0.72));
      this.rudder += Math.max(-42 * dt, Math.min(42 * dt, command.rudder - this.rudder));
    }
    let measured = poseFromFrame(rgb, this.beacons, this.course);
    const old = this.pose;
    if (measured && old && old.quality > 0
      && (Math.hypot(measured.north - old.north, measured.east - old.east) > 0.65 + 3.5 * dt
        || Math.abs(wrapAngle(measured.heading - old.heading)) > 0.19 + 0.9 * dt)) measured = null;
    if (measured) {
      this.pose = { ...measured, time };
      this.measurements.push(this.pose);
      this.measurements = this.measurements.filter((p) => time - p.time < 0.67);
      if (this.measurements.length > 1) this.shifts = regression(this.measurements);
    } else if (old) {
      this.pose = {
        north: old.north + this.shifts[0] * dt,
        east: old.east + this.shifts[1] * dt,
        heading: wrapAngle(old.heading + this.shifts[2] * dt),
        quality: 0, count: 0, time,
      };
    } else {
      this.pose = { north: 0, east: this.course.center, heading: 0, quality: 0, count: 0, time };
    }
    const { north, east, heading, quality } = this.pose;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const [velocityN, velocityE, yawRate] = this.shifts;
    const forwardSpeed = Math.max(-1, Math.min(3.1, velocityN * c + velocityE * s));
    const acrossSpeed = Math.max(-0.8, Math.min(0.8, -velocityN * s + velocityE * c));
    const feature = [
      north / 38, east / 6, heading, forwardSpeed / 2.4, acrossSpeed / 0.5,
      Math.max(-1, Math.min(1, yawRate)) / 0.6, this.rpm / 2400, this.rudder / 35,
      command.rpm / 2400, command.rudder / 35, quality, time / 38,
    ];
    const item = { image: shrinkFrame(rgb), feature };
    this.items.push(item);
    if (this.items.length > historyLength) this.items.shift();
    this.time = time;
    return item;
  }
}
