const palette = [
  { label: '橙标', color: 0xd76227, band: 0xffd0a4 },
  { label: '黄标', color: 0xcd952e, band: 0xffedb7 },
  { label: '绿标', color: 0x367c77, band: 0xc8f4dd },
  { label: '蓝标', color: 0x4c79a9, band: 0xbad5ff },
];

export const buoyBands = palette.map(({ label, band }, index) => ({ id: index + 1, label, band }));
export const raftRadius = 0.94;
export const raftBand = 0xe7567a;

function chart(id, title, center, bank, marks, [north, east, halfWidth, speed = null]) {
  return {
    id, title, center, bank,
    marks: marks.map(([id, north, east, side]) => ({ id, north, east, side, radius: 0.30, ...palette[id - 1] })),
    gate: { north, east, halfWidth, speed },
  };
}

const original = chart('original', '基础绕标', 0, 8.9,
  [[1, 8, 0, 1], [2, 19, 0, -1], [3, 30, 0, 1]], [38, 0, 2]);

export const testCourses = [
  chart('breakwater', '外堤港 · 综合航次', 0.65, 9.7,
    [[3, 8.4, 0.25, -1], [1, 19.3, -0.45, 1], [4, 30.1, 0.65, -1]], [55.5, 1.1, 1.38, 0.85]),
  chart('inlet', '内湾港 · 综合航次', -0.55, 7.8,
    [[2, 8.1, -0.65, 1], [4, 18.5, 0.15, -1], [1, 29.6, -0.3, -1], [3, 39.9, 0.4, 1]], [65.4, -2.0, 1.34, 0.85]),
];

export const trainingCourses = [original,
  chart('drydock', '船坞训练区', -0.15, 8.15,
    [[2, 8.6, 0.5, -1], [1, 20, 0.3, 1]], [45.2, -0.4, 1.5, 0.9]),
  chart('estuary', '河口训练区', 1.5, 10.1,
    [[4, 7.9, 1.8, 1], [1, 18.6, 0.85, -1], [2, 29.8, 1.4, 1]], [53.6, 0.4, 1.55, 0.82]),
  chart('quay', '码头训练区', -1.25, 9.15,
    [[1, 8.3, -1.6, 1], [3, 17.7, -0.8, -1], [2, 27, -0.9, 1], [4, 36.4, -1.9, -1]], [63.5, -1.9, 1.65, 0.9]),
  chart('basin', '回旋训练区', 0.4, 7.65,
    [[3, 7.7, 0.4, -1], [4, 17.4, 0.1, 1], [2, 27.8, 0.5, -1]], [50.6, 1.8, 1.58, 0.85]),
];

export const playableCourses = [...testCourses, original];

export function randomSource(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// This object belongs to the simulator. The controller receives the separate chart above.
export function placeRaft(course, seed) {
  if (course.gate.speed === null) return null;
  const random = randomSource(seed * 9257 + 8717);
  const eastOffset = random() - 0.5;
  const span = course.gate.north - course.marks.at(-1).north;
  return {
    north: course.marks.at(-1).north + span * 0.42 + (random() - 0.5) * 2.4,
    east: (course.marks.at(-1).east + course.gate.east) * 0.5 + eastOffset * 2.6,
    radius: raftRadius,
  };
}
