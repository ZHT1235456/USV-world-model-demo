import { decisionStep, wrapAngle } from './mission.js';
import { buoyBands, gateBands } from './courses.js';
import { cameraForward, cameraHeight, focal, sensorHeight, sensorWidth } from './optics.js';
import { clamp } from './simulation.js';

const bandColors = buoyBands.map(({ id, band }) => ({
  id,
  r: band >> 16,
  g: (band >> 8) & 255,
  b: band & 255,
}));
const buoyLabels = new Map(buoyBands.map(({ id, label }) => [id, label]));
const gateColors = gateBands.map(({ color }) => [color >> 16, (color >> 8) & 255, color & 255]);

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

export function detectGate(rgb) {
  const labeled = new Uint8Array(sensorWidth * sensorHeight);
  // Both colored sleeves sit near the horizon while the boat approaches the gate.
  for (let pixel = sensorWidth * 24; pixel < sensorWidth * 57; pixel++) {
    const i = pixel * 3;
    const signature = gateColors.findIndex(([r, g, b]) =>
      (rgb[i] - r) ** 2 + (rgb[i + 1] - g) ** 2 + (rgb[i + 2] - b) ** 2 <= 64);
    labeled[pixel] = signature + 1;
  }
  const posts = [null, null];
  for (let pixel = 0; pixel < labeled.length; pixel++) {
    const id = labeled[pixel];
    if (!id) continue;
    const patch = measureBand(labeled, pixel, id);
    if (patch.count >= 2 && patch.count > (posts[id - 1]?.count ?? 0)) posts[id - 1] = patch;
  }
  const [port, starboard] = posts;
  if (!port || !starboard) return null;
  const span = (starboard.minX + starboard.maxX - port.minX - port.maxX) / 2;
  const rise = (starboard.minY + starboard.maxY - port.minY - port.maxY) / 2;
  if (span < 4 || Math.abs(rise) > Math.max(2, span * 0.14)) return null;
  const left = Math.max(0, port.minX - 1);
  const right = Math.min(sensorWidth, starboard.maxX + 2);
  const top = Math.max(0, Math.min(port.minY, starboard.minY) - 1);
  const bottom = Math.min(sensorHeight, Math.max(port.maxY, starboard.maxY) + 2);
  return { id: 'gate', label: '终点 · 出场门', x: left, y: top, width: right - left, height: bottom - top,
    count: port.count + starboard.count };
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

// ── HUD language ────────────────────────────────────────────────────────
// The analysis canvas is the model's eye, so its marks follow the console
// language: sea-glass for perception, coral for the obstacle, amber for the
// forecast. Every coloured mark is laid over a thin ink casing so it holds on
// the pale dawn sky as well as on the dark water. Nothing glows, nothing
// animates — only the marks that do a job are drawn.
const HUD = {
  ink: 'rgba(7, 16, 19, .9)',
  casing: 'rgba(7, 16, 19, .66)',
  plate: 'rgba(6, 14, 16, .88)',
  bone: '#f2eadf',
  amber: '#f3c86f',
  guide: '#8ce2a0',
  sea: '#6fd9cc',
  seaActive: '#b9f7ec',
  gate: '#a4e3f7',
  coral: '#e2947f',
};

// Translucent border/fill from a solid hex mark colour.
function tinted(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// Four L-corners of a target box. Arm is 22% of the shorter side, with a
// floor of ~7 display-canvas px so far targets stay bracketed.
function cornerPath(ctx, box, arm) {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  ctx.moveTo(box.x, box.y + arm);
  ctx.lineTo(box.x, box.y);
  ctx.lineTo(box.x + arm, box.y);
  ctx.moveTo(right - arm, box.y);
  ctx.lineTo(right, box.y);
  ctx.lineTo(right, box.y + arm);
  ctx.moveTo(right, bottom - arm);
  ctx.lineTo(right, bottom);
  ctx.lineTo(right - arm, bottom);
  ctx.moveTo(box.x + arm, bottom);
  ctx.lineTo(box.x, bottom);
  ctx.lineTo(box.x, bottom - arm);
}

function drawTarget(ctx, box, color, active, unit) {
  const px = (value) => value * unit;
  const shorter = Math.min(box.width, box.height);
  const arm = Math.min(Math.max(shorter * 0.22, px(7)), shorter * 0.42, px(30));
  ctx.save();
  ctx.lineJoin = 'miter';

  // Ghost field: a 1px trace of the full rectangle, quiet enough to stay a
  // field note rather than a second frame.
  ctx.lineWidth = px(1);
  ctx.strokeStyle = color;
  ctx.globalAlpha = active ? 0.3 : 0.24;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // Corner brackets, cased in ink so the sea-glass holds on the bright sky.
  ctx.globalAlpha = 1;
  ctx.beginPath();
  cornerPath(ctx, box, arm);
  ctx.lineWidth = px(5);
  ctx.strokeStyle = HUD.casing;
  ctx.stroke();
  ctx.beginPath();
  cornerPath(ctx, box, arm);
  ctx.lineWidth = px(2.4);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, box, color, active, fontSize, unit, tags) {
  const px = (value) => value * unit;
  const name = box.label ?? (box.id === 'raft' ? '浮排' : buoyLabels.get(box.id) ?? '航标');
  const padX = px(4);
  const textWidth = ctx.measureText(name).width;
  const width = padX * 2 + textWidth;
  const height = fontSize + px(4.8);
  const x = clamp(box.x, px(1.5), sensorWidth - width - px(1.5));
  const y = Math.max(px(1.5), box.y - height - px(1.5));
  if (tags.some((tag) => x < tag.x + tag.width && x + width > tag.x
    && y < tag.y + tag.height && y + height > tag.y)) return;
  tags.push({ x, y, width, height });

  // Sharp label plate: dark ink, hairline in the target colour, bone type.
  ctx.fillStyle = HUD.plate;
  ctx.fillRect(x, y, width, height);
  ctx.lineWidth = px(1);
  ctx.strokeStyle = tinted(color, active ? 0.8 : 0.55);
  ctx.strokeRect(x + px(0.5), y + px(0.5), width - px(1), height - px(1));

  // Centre on the glyph ink box rather than the em box: CJK glyphs sit low.
  const metrics = ctx.measureText(name);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.74;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.22;
  ctx.fillStyle = HUD.bone;
  ctx.fillText(name, x + padX, y + (height - ascent - descent) / 2 + ascent);
}

function drawBoxes(ctx, detections, activeId, guide, fontSize, unit) {
  const sorted = detections.slice().sort((a, b) =>
    Number(b.id === 'gate') - Number(a.id === 'gate')
    || Number(b.id === activeId) - Number(a.id === activeId) || b.count - a.count);
  const tags = [];
  ctx.font = `500 ${fontSize}px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
  ctx.textBaseline = 'alphabetic';
  for (const box of sorted) {
    const active = box.id === activeId;
    const color = box.id === 'gate' ? HUD.gate : active ? HUD.seaActive : box.id === 'raft' ? HUD.coral : HUD.sea;
    drawTarget(ctx, box, color, active, unit);
    drawLabel(ctx, box, color, active, fontSize, unit, tags);
  }
  if (guide) {
    const { tail, tip } = guide;
    drawArrow(ctx, [tail, tip], unit, HUD.guide);
    drawLabel(ctx, { x: Math.min(tail.x, tip.x), y: Math.min(tail.y, tip.y), label: '航道方向' },
      HUD.guide, true, fontSize, unit, tags);
  }
}

// Forecast line: one amber stroke in an ink casing with a single clean
// arrowhead. No shadowBlur — the casing does the contrast work on both the
// pale sky and the dark water.
function drawArrow(ctx, points, unit, color = HUD.amber) {
  if (points.length < 2) return;
  const px = (value) => value * unit;
  const end = points.at(-1);
  const previous = points.at(-2);
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const trace = () => {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) ctx.lineTo(points[index].x, points[index].y);
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  trace();
  ctx.lineWidth = px(4.8);
  ctx.strokeStyle = HUD.ink;
  ctx.stroke();
  ctx.beginPath();
  trace();
  ctx.lineWidth = px(2.05);
  ctx.strokeStyle = color;
  ctx.stroke();

  // Arrowhead: ink casing, amber tip, sized like a plotted course mark.
  ctx.translate(end.x, end.y);
  ctx.rotate(angle);
  const head = (nose, back, half) => {
    ctx.beginPath();
    ctx.moveTo(px(nose), 0);
    ctx.lineTo(px(back), px(half));
    ctx.lineTo(px(back), px(-half));
    ctx.closePath();
  };
  head(5.8, -4.6, 4.9);
  ctx.fillStyle = HUD.ink;
  ctx.fill();
  head(4.8, -3.6, 3.7);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export function paintVisionOverlay(canvas, source, frame, plan) {
  // A transparent-capable context keeps canvas text on grayscale antialiasing:
  // the camera frame still covers every pixel, and small CJK labels stop
  // picking up LCD colour fringing.
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / sensorWidth, 0, 0, canvas.height / sensorHeight, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, sensorWidth, sensorHeight);
  // HUD metrics are quoted in display-canvas px; the transform draws in
  // sensor px, so one display-canvas px is this many sensor px.
  const unit = sensorWidth / canvas.width;
  drawArrow(ctx, projectedRoute(plan, frame.time), unit);
  const pictureWidth = Math.min(canvas.clientWidth, canvas.clientHeight * sensorWidth / sensorHeight);
  const fontSize = clamp(10.2 * sensorWidth / Math.max(1, pictureWidth), 2.6, 9.2);
  const active = plan?.maneuver === 'gate' ? 'gate' : plan?.maneuver?.startsWith('avoid-') ? 'raft' : plan?.activeMark;
  drawBoxes(ctx, frame.detections, active, frame.guide, fontSize, unit);
}
