import { raftBand, raftRadius } from './courses.js';
import { cameraForward, focal, sensorHeight, sensorWidth } from './optics.js';

const red = raftBand >> 16, green = (raftBand >> 8) & 255, blue = raftBand & 255;

export function detectRaft(rgb) {
  let left = sensorWidth, right = -1, top = sensorHeight, bottom = -1, count = 0;
  for (let y = sensorHeight / 2; y < sensorHeight; y++) {
    for (let x = 0; x < sensorWidth; x++) {
      const i = (y * sensorWidth + x) * 3;
      if ((rgb[i] - red) ** 2 + (rgb[i + 1] - green) ** 2 + (rgb[i + 2] - blue) ** 2 > 36) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      count++;
    }
  }
  const span = right - left + 1;
  if (span < 5 || count < 0.7 * span) return null;
  const x = Math.max(0, left - 1), y = Math.max(0, top - 2);
  const box = { id: 'raft', x, y, width: Math.min(sensorWidth, right + 2) - x,
    height: Math.min(sensorHeight, bottom + 2) - y, count };
  if (left <= 1 || right >= sensorWidth - 2) return { box, range: null };

  // The horizontal tangents of a circle give bearing and range from its known radius.
  const low = Math.atan((left - sensorWidth / 2) / focal);
  const high = Math.atan((right + 1 - sensorWidth / 2) / focal);
  return { box, bearing: (low + high) * 0.5, range: raftRadius / Math.sin((high - low) * 0.5) };
}

export class RaftTrack {
  constructor() {
    this.samples = [];
    this.position = null;
  }

  observe(rgb, pose, time) {
    if (this.position || pose.quality < 0.20) return;
    const target = detectRaft(rgb);
    if (!target?.range || target.range > 16.0 || target.range < 3.2) return;
    const bearing = pose.heading + target.bearing;
    const north = pose.north + cameraForward * Math.cos(pose.heading) + target.range * Math.cos(bearing);
    const east = pose.east + cameraForward * Math.sin(pose.heading) + target.range * Math.sin(bearing);
    this.samples = this.samples.filter((sample) => time - sample.time < 0.65);
    this.samples.push({ north, east, time });
    if (this.samples.length < 4) return;
    const median = (axis) => this.samples.map((sample) => sample[axis]).sort((a, b) => a - b)[Math.floor(this.samples.length / 2)];
    const center = { north: median('north'), east: median('east') };
    const agreeing = this.samples.filter((sample) => Math.hypot(sample.north - center.north, sample.east - center.east) < 1.2);
    if (agreeing.length >= 4) this.position = { ...center, radius: raftRadius };
  }
}
