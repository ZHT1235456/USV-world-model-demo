import { decisionStep, wrapAngle } from './mission.js';
import { buoyBands } from './courses.js';
import { cameraForward, cameraHeight, focal, sensorHeight, sensorWidth } from './optics.js';
import { clamp } from './simulation.js';

const bandColors = buoyBands.map(({ id, band }) => ({
  id,
  r: band >> 16,
  g: (band >> 8) & 255,
  b: band & 255,
}));
const buoyLabels = new Map(buoyBands.map(({ id, label }) => [id, label]));

function bandPixels(rgb) {
  const labeled = new Uint8Array(sensorWidth * sensorHeight);
  // The color bands are beneath the horizon of the level bow camera.
  for (let pixel = sensorWidth * (sensorHeight / 2); pixel < labeled.length; pixel++) {
    const offset = pixel * 3;
    const r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2];
    if (r < 185 || g < 195 || b < 152) continue;
    const match = bandColors.find((color) =>
      (r - color.r) ** 2 + (g - color.g) ** 2 + (b - color.b) ** 2 <= 36);
    if (match) labeled[pixel] = match.id;
  }
  return labeled;
}

function measureBand(pixels, start, id) {
  const pending = [start];
  pixels[start] = 0;
  let minX = sensorWidth, minY = sensorHeight, maxX = 0, maxY = 0;
  for (let head = 0; head < pending.length; head++) {
    const index = pending[head];
    const x = index % sensorWidth, y = Math.floor(index / sensorWidth);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    for (let adjacentY = Math.max(y - 1, 0); adjacentY <= Math.min(y + 1, sensorHeight - 1); adjacentY++) {
      for (let adjacentX = Math.max(x - 1, 0); adjacentX <= Math.min(x + 1, sensorWidth - 1); adjacentX++) {
        const next = adjacentY * sensorWidth + adjacentX;
        if (pixels[next] === id) {
          pixels[next] = 0;
          pending.push(next);
        }
      }
    }
  }
  return { minX, minY, maxX, maxY, count: pending.length };
}

export function detectBuoys(rgb) {
  const labeled = bandPixels(rgb);
  const best = new Map();
  for (let start = 0; start < labeled.length; start++) {
    const id = labeled[start];
    if (!id) continue;
    const { minX, minY, maxX, maxY, count } = measureBand(labeled, start, id);
    const bandWidth = maxX - minX + 1;
    const bandHeight = maxY - minY + 1;
    if (bandWidth < 2 || bandHeight > 0.55 * bandWidth + 1 || count < 0.70 * bandWidth) continue;
    if ((best.get(id)?.count ?? 0) >= count) continue;

    // Use the measured width of the stripe to bound the rest of the buoy.
    const margin = Math.max(1, bandWidth * 0.14);
    const left = Math.max(0, minX - margin);
    const top = Math.max(0, minY - bandWidth * 1.05 - 1);
    const right = Math.min(sensorWidth, maxX + 1 + margin);
    const bottom = Math.min(sensorHeight, maxY + 1 + bandWidth * 0.55 + 1);
    best.set(id, { id, x: left, y: top, width: right - left, height: bottom - top, count });
  }
  return [...best.values()];
}

function projectedRoute(plan, frameTime) {
  if (!plan?.trajectory.length || !Number.isFinite(plan.observationTime)) return [];
  const elapsed = clamp(frameTime - plan.observationTime, 0, plan.trajectory.at(-1).seconds);
  const index = Math.min(plan.trajectory.length - 2, Math.floor(elapsed / decisionStep));
  const from = plan.trajectory[index];
  const next = plan.trajectory[index + 1];
  const fraction = clamp((elapsed - from.seconds) / decisionStep, 0, 1);
  const yaw = from.heading + wrapAngle(next.heading - from.heading) * fraction;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const cameraN = from.north + (next.north - from.north) * fraction + cameraForward * c;
  const cameraE = from.east + (next.east - from.east) * fraction + cameraForward * s;
  return plan.trajectory.flatMap((point) => {
    if (point.seconds < elapsed || point.seconds > elapsed + 3) return [];
    const n = point.north - cameraN, e = point.east - cameraE;
    const depth = n * c + e * s;
    if (depth < 0.7) return [];
    const x = sensorWidth / 2 + focal * (-n * s + e * c) / depth;
    const y = sensorHeight / 2 + focal * cameraHeight / depth;
    if (x < 3 || x > sensorWidth - 3 || y > sensorHeight - 2) return [];
    return [{ x, y }];
  });
}

function drawArrow(ctx, points) {
  if (points.length < 2) return;
  const end = points.at(-1), previous = points.at(-2);
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = '#14232ad1';
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = '#ffd096';
  ctx.shadowBlur = 5;
  ctx.shadowColor = '#f2aa60';
  ctx.stroke();
  ctx.translate(end.x, end.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(3.4, 0);
  ctx.lineTo(-2.7, 2.9);
  ctx.lineTo(-2.7, -2.9);
  ctx.closePath();
  ctx.fillStyle = '#ffd096';
  ctx.fill();
  ctx.restore();
}

function drawBoxes(ctx, detections, activeId, fontSize) {
  const sorted = detections.slice().sort((a, b) =>
    Number(b.id === activeId) - Number(a.id === activeId) || b.count - a.count);
  const tags = [];
  ctx.font = `500 ${fontSize}px "Microsoft YaHei UI", sans-serif`;
  ctx.textBaseline = 'middle';
  for (const box of sorted) {
    const active = box.id === activeId;
    const color = box.id === 'raft' ? '#ffc18b' : active ? '#a5ffe2' : '#77e0cf';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#132f37db';
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.lineWidth = active ? 0.96 : 0.67;
    ctx.strokeStyle = color;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    const name = box.id === 'raft' ? '浮排' : buoyLabels.get(box.id);
    const width = ctx.measureText(name).width + 4;
    const height = fontSize + 3;
    const x = clamp(box.x, 1, sensorWidth - width - 1);
    const y = Math.max(1, box.y - height - 1);
    if (tags.some((tag) => x < tag.x + tag.width && x + width > tag.x
      && y < tag.y + tag.height && y + height > tag.y)) continue;
    tags.push({ x, y, width, height });
    ctx.fillStyle = '#132f37ed';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = color;
    ctx.fillText(name, x + 2, y + height / 2);
  }
}

export function paintVisionOverlay(canvas, source, frame, plan) {
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(canvas.width / sensorWidth, 0, 0, canvas.height / sensorHeight, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, sensorWidth, sensorHeight);
  drawArrow(ctx, projectedRoute(plan, frame.time));
  const pictureWidth = Math.min(canvas.clientWidth, canvas.clientHeight * sensorWidth / sensorHeight);
  const fontSize = clamp(10.5 * sensorWidth / Math.max(1, pictureWidth), 5.8, 11.5);
  const active = plan?.maneuver?.startsWith('avoid-') ? 'raft' : plan?.activeMark;
  drawBoxes(ctx, frame.detections, active, fontSize);
}
