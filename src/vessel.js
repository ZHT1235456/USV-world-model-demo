import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Body frame: +X forward, +Y up, +Z starboard. Dimensions in metres.
// Each station gives longitudinal position, half breadth, sheer and keel elevation.
const stations = [
  [-1.2, 0.34, 0.163, -0.102],
  [-1.168, 0.371, 0.163, -0.114],
  [-1.085, 0.398, 0.162, -0.133],
  [-0.92, 0.425, 0.163, -0.149],
  [-0.68, 0.444, 0.166, -0.163],
  [-0.43, 0.45, 0.17, -0.17],
  [-0.16, 0.449, 0.176, -0.172],
  [0.1, 0.437, 0.186, -0.165],
  [0.33, 0.411, 0.2, -0.152],
  [0.52, 0.369, 0.216, -0.136],
  [0.7, 0.305, 0.235, -0.109],
  [0.86, 0.227, 0.254, -0.075],
  [0.995, 0.148, 0.271, -0.025],
  [1.095, 0.082, 0.282, 0.049],
  [1.155, 0.038, 0.289, 0.128],
  [1.192, 0.008, 0.293, 0.218],
  [1.2, 0.001, 0.294, 0.279],
];
const V = (p) => new THREE.Vector3(...p);

function section(x) {
  const upper = stations.findIndex((s) => s[0] >= x);
  if (upper <= 0) return upper === 0 ? stations[0] : stations.at(-1);
  const a = stations[upper - 1],
    b = stations[upper];
  const t = (x - a[0]) / (b[0] - a[0]);
  return a.map((n, i) => THREE.MathUtils.lerp(n, b[i], t));
}
function deckY(x, z = 0) {
  const [, w, top] = section(x);
  return top + 0.012 * (1 - Math.min(1, Math.abs(z) / w));
}
function material(name, color, roughness = 0.47, metalness = 0.08) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  m.name = name;
  return m;
}
function part(parent, name) {
  const group = new THREE.Group();
  group.name = name;
  parent.add(group);
  return group;
}
function mesh(parent, geometry, mat, position = [0, 0, 0]) {
  const o = new THREE.Mesh(geometry, mat);
  o.position.set(...position);
  o.castShadow = o.receiveShadow = true;
  parent.add(o);
  return o;
}
function box(parent, mat, center, dims, radius = 0) {
  const geometry = radius ? new RoundedBoxGeometry(...dims, 2, radius) : new THREE.BoxGeometry(...dims);
  return mesh(parent, geometry, mat, center);
}
function rod(parent, mat, a, b, radius, radiusAtB = radius, sides = 12) {
  const start = V(a),
    end = V(b),
    delta = end.clone().sub(start);
  const o = mesh(parent, new THREE.CylinderGeometry(radiusAtB, radius, delta.length(), sides), mat);
  o.position.copy(start).lerp(end, 0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return o;
}
function ellipsoid(parent, mat, center, radii) {
  const o = mesh(parent, new THREE.SphereGeometry(1, 28, 16), mat, center);
  o.scale.set(...radii);
  return o;
}
function tube(parent, mat, points, radius, segments = 22) {
  const path = new THREE.CatmullRomCurve3(points.map(V), false, 'centripetal');
  return mesh(parent, new THREE.TubeGeometry(path, segments, radius, 8, false), mat);
}
function gridGeometry(rows, reverse = false) {
  const positions = [],
    uvs = [],
    indices = [];
  const cols = rows[0].length;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < cols; j++) {
      positions.push(...rows[i][j]);
      uvs.push(i / (rows.length - 1), j / (cols - 1));
      if (i + 1 >= rows.length || j + 1 >= cols) continue;
      const a = i * cols + j,
        b = a + cols;
      if (reverse) indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
function polygonGeometry(points, reverse = false) {
  const g = new THREE.BufferGeometry();
  const idx = [];
  const origin = V(points[0]);
  for (let i = 1; i < points.length - 1; i++) {
    const area = V(points[i])
      .sub(origin)
      .cross(V(points[i + 1]).sub(origin));
    if (area.lengthSq() > 1e-22) idx.push(...(reverse ? [0, i + 1, i] : [0, i, i + 1]));
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  g.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      points.flatMap((p) => [p[0], p[2]]),
      2
    )
  );
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeMaterials() {
  return {
    white: material('Porcelain white gelcoat', 0xebf0ec, 0.32),
    deck: material('Cool white moulded deck', 0xdce3df, 0.6),
    blue: material('Deep ultramarine enamel', 0x104578, 0.32, 0.22),
    paint: material('Ocean blue cover', 0x195985, 0.34, 0.18),
    stripe: material('Signal blue pinstripe', 0x3a93bd, 0.35, 0.18),
    bottom: material('Navy antifouling coat', 0x173747, 0.67),
    rubber: material('Graphite rubber', 0x222e34, 0.8, 0.02),
    dark: material('Anodised instrument housing', 0x243a42, 0.44, 0.56),
    silver: material('Brushed stainless steel', 0xadc1c5, 0.27, 0.8),
    steel: material('Satin aluminium', 0x879ba2, 0.39, 0.67),
    mat: material('Non-skid hatch inset', 0x71858b, 0.78),
    gray: material('Light grey service panel', 0xbac7c6, 0.61),
    bronze: material('Manganese bronze', 0xb78347, 0.29, 0.76),
    lens: material('Coated optical glass', 0x124e59, 0.13, 0.55),
    red: material('Port navigation light', 0xb82e29, 0.25),
    green: material('Starboard navigation light', 0x14816a, 0.25),
  };
}

function profile([x, w, h, k], side) {
  // Offsets converge into the stem rather than crossing as the bow closes.
  const d = Math.min(1, (h - k) / 0.18);
  const sheer = h - 0.075 * d,
    chine = h - (h - k) * 0.66;
  const waterMark = (elevation, margin) => {
    const y = THREE.MathUtils.clamp(elevation, chine + margin * d, sheer - (0.014 - margin) * d);
    const fraction = (sheer - y) / (sheer - chine);
    return [x, y, side * w * THREE.MathUtils.lerp(0.977, 0.898, fraction)];
  };
  return [
    [x, h, side * w * 0.988],
    [x, h - 0.006 * d, side * w],
    [x, h - 0.018 * d, side * w],
    [x, h - 0.025 * d, side * w * 0.992],
    [x, h - 0.07 * d, side * w * 0.98],
    [x, sheer, side * w * 0.977],
    waterMark(0.02, 0.01),
    waterMark(0.004, 0.003),
    [x, chine, side * w * 0.898],
    [x, k + (h - k) * 0.2, side * w * 0.77],
    [x, k + (h - k) * 0.06, side * w * 0.31],
    [x, k, 0],
  ];
}
function deckRibbon(parent, mat, x0, x1, width, height = 0.002) {
  const xs = [x0, ...stations.map((s) => s[0]).filter((x) => x > x0 && x < x1), x1];
  const rows = xs.map((x) => {
    const half = section(x)[1] * width;
    return [-half, 0, half].map((z) => [x, deckY(x, z) + height, z]);
  });
  return mesh(parent, gridGeometry(rows), mat);
}
function buildHull(parent, m) {
  const bands = [
    m.dark,
    m.rubber,
    m.white,
    m.blue,
    m.stripe,
    m.white,
    m.blue,
    m.bottom,
    m.bottom,
    m.bottom,
    m.bottom,
  ];
  for (const side of [-1, 1]) {
    const frames = stations.map((st) => profile(st, side));
    bands.forEach((mat, i) =>
      mesh(
        parent,
        gridGeometry(
          frames.map((frame) => [frame[i], frame[i + 1]]),
          side < 0
        ),
        mat
      )
    );
  }
  for (const [end, reverse] of [
    [0, true],
    [stations.length - 1, false],
  ]) {
    const port = profile(stations[end], -1),
      starboard = profile(stations[end], 1);
    bands.forEach((mat, i) =>
      mesh(parent, polygonGeometry([port[i], starboard[i], starboard[i + 1], port[i + 1]], reverse), mat)
    );
    const [x] = stations[end];
    mesh(parent, polygonGeometry([port[0], [x, deckY(x), 0], starboard[0]], reverse), m.deck);
  }
  mesh(
    parent,
    gridGeometry(stations.map(([x, w]) => [-0.988 * w, 0, 0.988 * w].map((z) => [x, deckY(x, z), z]))),
    m.deck
  );
  deckRibbon(parent, m.blue, 0.787, 1.194, 0.945);
  deckRibbon(parent, m.stripe, 0.738, 0.757, 0.918);
  deckRibbon(parent, m.blue, 0.71, 0.725, 0.907);
}

// Chamfered, tapered equipment enclosures; each ring is a true horizontal section.
function outline(x0, x1, back, front, y, cut) {
  return [
    [x0, -back + cut],
    [x0 + cut, -back],
    [x1 - cut, -front],
    [x1, -front + cut],
    [x1, front - cut],
    [x1 - cut, front],
    [x0 + cut, back],
    [x0, back - cut],
  ].map(([x, z]) => [x, y, z]);
}
function loft(parent, rings, sides, roof) {
  mesh(parent, polygonGeometry(rings[0]), sides[0]);
  for (let level = 0; level < rings.length - 1; level++) {
    const low = rings[level],
      high = rings[level + 1];
    for (let i = 0; i < low.length; i++) {
      const j = (i + 1) % low.length;
      mesh(parent, polygonGeometry([low[i], high[i], high[j], low[j]]), sides[level]);
    }
  }
  mesh(parent, polygonGeometry(rings.at(-1), true), roof);
}
function fastener(parent, m, x, y, z, radius = 0.006) {
  rod(parent, m, [x, y - 0.001, z], [x, y + 0.002, z], radius, radius, 6);
}
function buildPod(parent, m) {
  loft(
    parent,
    [
      outline(-0.52, 0.503, 0.322, 0.265, 0.173, 0.057),
      outline(-0.52, 0.511, 0.323, 0.268, 0.211, 0.055),
      outline(-0.49, 0.484, 0.308, 0.25, 0.233, 0.053),
      outline(-0.425, 0.387, 0.271, 0.212, 0.348, 0.052),
      outline(-0.42, 0.374, 0.265, 0.207, 0.359, 0.051),
    ],
    [m.gray, m.white, m.white, m.dark],
    m.rubber
  );
  loft(
    parent,
    [
      outline(-0.433, 0.394, 0.275, 0.217, 0.356, 0.054),
      outline(-0.435, 0.396, 0.277, 0.218, 0.369, 0.055),
      outline(-0.403, 0.359, 0.252, 0.196, 0.398, 0.053),
      outline(-0.392, 0.348, 0.245, 0.191, 0.404, 0.052),
    ],
    [m.dark, m.blue, m.paint],
    m.paint
  );
  for (const side of [-1, 1]) {
    // Recessed side ventilation cassettes and their separate louvres.
    const vent = part(parent, 'Side vents');
    vent.position.set(-0.13, 0.285, side * 0.284);
    vent.rotation.x = -side * 0.31;
    vent.rotation.y = side * 0.073;
    box(vent, m.dark, [0, 0, 0], [0.36, 0.054, 0.009], 0.004);
    for (let i = 0; i < 13; i++) {
      const louvre = box(
        vent,
        m.steel,
        [-0.157 + i * 0.026, 0.001, side * 0.006],
        [0.008, 0.037, 0.004],
        0.001
      );
      louvre.rotation.z = -0.25;
    }
    for (const x of [-0.366, 0.281]) {
      const w = x < 0 ? 0.241 : 0.193;
      fastener(parent, m.silver, x, 0.405, side * (w - 0.024));
    }
    for (const x of [-0.33, 0.2]) {
      const z = side * (x < 0 ? 0.307 : 0.264);
      box(parent, m.steel, [x, 0.229, z], [0.041, 0.027, 0.01], 0.003);
      box(parent, m.dark, [x, 0.235, z + side * 0.006], [0.021, 0.008, 0.003]);
    }
  }
  // Two roof-mounted grab handles with separate feet.
  for (const side of [-1, 1]) {
    const z = side * 0.176;
    tube(
      parent,
      m.silver,
      [
        [-0.31, 0.405, z],
        [-0.302, 0.432, z],
        [-0.277, 0.439, z],
        [-0.079, 0.439, z],
        [-0.059, 0.432, z],
        [-0.052, 0.405, z],
      ],
      0.0065
    );
    for (const x of [-0.31, -0.052]) box(parent, m.dark, [x, 0.406, z], [0.029, 0.006, 0.021], 0.002);
  }
}

function buildDeck(parent, m) {
  // Hinged stern service hatch, with drainage rim and non-slip ribs.
  const hatchX = -0.835;
  box(parent, m.rubber, [hatchX, 0.182, 0], [0.466, 0.018, 0.514], 0.014);
  box(parent, m.gray, [hatchX, 0.192, 0], [0.455, 0.015, 0.502], 0.014);
  box(parent, m.mat, [hatchX, 0.201, 0], [0.403, 0.008, 0.443], 0.012);
  for (let i = 0; i < 9; i++)
    box(parent, m.gray, [-1.008 + i * 0.042, 0.205, 0], [0.006, 0.003, 0.379], 0.0011);
  for (const side of [-1, 1]) {
    box(parent, m.silver, [-0.631, 0.203, side * 0.156], [0.058, 0.01, 0.042], 0.004);
    rod(parent, m.steel, [-0.63, 0.21, side * 0.156 - 0.029], [-0.63, 0.21, side * 0.156 + 0.029], 0.007);
    box(parent, m.dark, [-1.039, 0.204, side * 0.155], [0.037, 0.008, 0.032], 0.003);
    fastener(parent, m.silver, -1.039, 0.209, side * 0.155);
  }
  for (const side of [-1, 1]) {
    // Foredeck pulpit follows the sheer and tapers into the stem.
    const positions = [0.31, 0.44, 0.62, 0.78, 0.91, 1.025];
    const rail = positions.map((x) => {
      const z = side * (section(x)[1] - 0.038);
      return [x, deckY(x, z) + 0.104, z];
    });
    rail[0][1] -= 0.043;
    rail.at(-1)[1] -= 0.038;
    tube(parent, m.silver, rail, 0.0075, 30);
    for (const i of [0, 2, 4, 5]) {
      const [x, y, z] = rail[i],
        base = deckY(x, z);
      rod(parent, m.gray, [x, base, z], [x, base + 0.005, z], 0.017);
      rod(parent, m.silver, [x - 0.008, base + 0.003, z], [x, y, z], 0.0057);
    }
    // Aft side handholds and two mooring cleats on each gunwale.
    const z = side * 0.354;
    tube(
      parent,
      m.silver,
      [
        [-1.004, 0.17, z],
        [-0.988, 0.216, z],
        [-0.953, 0.225, z],
        [-0.672, 0.229, z],
        [-0.643, 0.218, z],
        [-0.634, 0.174, z],
      ],
      0.007
    );
    for (const x of [-1.115, 0.654]) {
      const zc = side * (section(x)[1] - 0.077),
        y = deckY(x, zc);
      box(parent, m.dark, [x, y + 0.004, zc], [0.092, 0.008, 0.026], 0.003);
      for (const dx of [-0.021, 0.021])
        rod(parent, m.silver, [x + dx, y + 0.006, zc], [x + dx, y + 0.033, zc], 0.006);
      rod(parent, m.silver, [x - 0.06, y + 0.039, zc], [x + 0.06, y + 0.039, zc], 0.007, 0.007);
    }
    for (const x of [-1.05, -0.76, -0.51, -0.23, 0.11, 0.47, 0.82]) {
      const zc = side * (section(x)[1] - 0.02);
      fastener(parent, m.steel, x, deckY(x, zc) + 0.0007, zc, 0.004);
    }
  }
  // Foredeck flush service cover, its hinges and towing eye.
  const fore = part(parent, 'Foredeck access hatch');
  fore.position.set(0.566, deckY(0.566) + 0.005, 0);
  fore.rotation.z = 0.1;
  box(fore, m.dark, [0, 0, 0], [0.194, 0.009, 0.263], 0.015);
  box(fore, m.gray, [0, 0.006, 0], [0.183, 0.008, 0.251], 0.013);
  for (const z of [-0.077, 0.077]) box(fore, m.steel, [-0.079, 0.014, z], [0.032, 0.006, 0.033], 0.002);
  box(fore, m.dark, [0.06, 0.013, 0], [0.019, 0.005, 0.05], 0.003);
  tube(
    parent,
    m.silver,
    [
      [1.051, 0.286, 0],
      [1.044, 0.312, 0],
      [1.015, 0.32, 0],
      [0.981, 0.313, 0],
      [0.975, 0.282, 0],
    ],
    0.0065
  );
  // Two recessed recovery eyes on the transom.
  for (const side of [-1, 1]) {
    const z = side * 0.226;
    box(parent, m.steel, [-1.197, 0.109, z], [0.005, 0.033, 0.061], 0.002);
    tube(
      parent,
      m.silver,
      [
        [-1.199, 0.113, z - 0.018],
        [-1.199, 0.121, z - 0.009],
        [-1.199, 0.123, z + 0.009],
        [-1.199, 0.113, z + 0.018],
      ],
      0.0016
    );
  }
}

function buildMast(parent, m) {
  // Four separate swept legs leave the sensor field of view clear.
  for (const side of [-1, 1]) {
    const z = side * 0.154;
    for (const x of [-0.349, -0.022]) {
      box(parent, m.dark, [x, 0.41, z], [0.079, 0.012, 0.058], 0.005);
      rod(parent, m.steel, [x, 0.417, z], [x, 0.433, z], 0.025, 0.022);
      for (const dx of [-0.029, 0.029]) fastener(parent, m.silver, x + dx, 0.417, z, 0.004);
    }
    rod(parent, m.silver, [-0.349, 0.426, z], [-0.195, 0.767, side * 0.111], 0.017, 0.014);
    rod(parent, m.silver, [-0.022, 0.426, z], [-0.16, 0.767, side * 0.111], 0.017, 0.014);
    rod(parent, m.dark, [-0.291, 0.551, side * 0.139], [-0.081, 0.564, side * 0.139], 0.008);
    box(parent, m.gray, [-0.178, 0.77, side * 0.113], [0.092, 0.025, 0.07], 0.006);
  }
  rod(parent, m.silver, [-0.25, 0.62, -0.13], [-0.25, 0.62, 0.13], 0.012);
  box(parent, m.dark, [-0.17, 0.786, 0], [0.123, 0.033, 0.373], 0.008);
  box(parent, m.silver, [-0.17, 0.805, 0], [0.13, 0.012, 0.385], 0.004);
  for (const x of [-0.213, -0.127])
    for (const z of [-0.149, 0.129]) fastener(parent, m.steel, x, 0.812, z, 0.0045);
  // Survey GNSS puck, white radome with a distinct seal and mounting stem.
  rod(parent, m.steel, [-0.177, 0.811, -0.019], [-0.177, 0.862, -0.019], 0.022);
  rod(parent, m.gray, [-0.177, 0.852, -0.019], [-0.177, 0.882, -0.019], 0.066, 0.104, 44);
  rod(parent, m.blue, [-0.177, 0.88, -0.019], [-0.177, 0.891, -0.019], 0.105, 0.105, 48);
  rod(parent, m.white, [-0.177, 0.89, -0.019], [-0.177, 0.91, -0.019], 0.105, 0.102, 48);
  ellipsoid(parent, m.white, [-0.177, 0.909, -0.019], [0.102, 0.028, 0.102]);
  // Spring-mounted radio whip on the opposite end of the crossarm.
  rod(parent, m.dark, [-0.172, 0.813, 0.152], [-0.172, 0.843, 0.152], 0.014, 0.012);
  for (let i = 0; i < 5; i++)
    rod(parent, m.silver, [-0.172, 0.842 + i * 0.005, 0.152], [-0.172, 0.845 + i * 0.005, 0.152], 0.01);
  rod(parent, m.dark, [-0.172, 0.868, 0.152], [-0.201, 1.087, 0.152], 0.0039, 0.0012, 10);
  for (const side of [-1, 1]) {
    const z = side * 0.181;
    box(parent, m.dark, [-0.127, 0.801, z], [0.035, 0.023, 0.028], 0.005);
    box(parent, side < 0 ? m.red : m.green, [-0.123, 0.815, z], [0.03, 0.014, 0.025], 0.004);
    box(parent, m.dark, [-0.141, 0.813, z], [0.005, 0.015, 0.025], 0.001);
  }
  // Gimballed EO head facing +X. The hood, aperture and front glass are separate.
  box(parent, m.dark, [-0.095, 0.702, 0], [0.157, 0.027, 0.163], 0.008);
  rod(parent, m.steel, [-0.136, 0.701, 0], [-0.136, 0.776, 0], 0.026);
  for (const side of [-1, 1]) {
    box(parent, m.gray, [-0.06, 0.669, side * 0.068], [0.06, 0.079, 0.017], 0.006);
    rod(parent, m.dark, [-0.054, 0.645, side * 0.063], [-0.054, 0.645, side * 0.082], 0.019, 0.019);
  }
  ellipsoid(parent, m.white, [-0.05, 0.638, 0], [0.076, 0.067, 0.064]);
  rod(parent, m.dark, [-0.009, 0.64, 0], [0.033, 0.64, 0], 0.049, 0.045, 36);
  rod(parent, m.rubber, [0.033, 0.64, 0], [0.039, 0.64, 0], 0.045, 0.04, 36);
  rod(parent, m.steel, [0.0385, 0.64, 0], [0.04, 0.64, 0], 0.034, 0.033, 36);
  rod(parent, m.lens, [0.04, 0.64, 0], [0.042, 0.64, 0], 0.031, 0.031, 36);
  rod(parent, m.dark, [0.042, 0.64, 0], [0.043, 0.64, 0], 0.02, 0.02, 36);
  ellipsoid(parent, m.lens, [0.044, 0.64, 0], [0.004, 0.014, 0.014]);
  tube(
    parent,
    m.rubber,
    [
      [-0.034, 0.631, 0.055],
      [-0.088, 0.61, 0.082],
      [-0.144, 0.644, 0.082],
      [-0.169, 0.726, 0.094],
      [-0.263, 0.55, 0.143],
      [-0.34, 0.427, 0.153],
    ],
    0.005
  );
}

function buildDrive(root, m) {
  const fixed = part(root, 'Shaft and stern fittings');
  const shaftPoint = (x) => [x, -0.254 + (x + 1.006) * 0.265, 0];
  rod(fixed, m.dark, shaftPoint(-0.61), shaftPoint(-0.752), 0.041, 0.027);
  rod(fixed, m.silver, shaftPoint(-0.749), shaftPoint(-0.976), 0.012);
  rod(fixed, m.bronze, [-0.902, -0.109, 0.068], shaftPoint(-0.958), 0.009);
  rod(fixed, m.bronze, [-0.902, -0.109, -0.068], shaftPoint(-0.958), 0.009);
  rod(fixed, m.bronze, shaftPoint(-0.936), shaftPoint(-0.977), 0.02);
  const shaftAxis = part(root, 'Propeller shaft axis');
  shaftAxis.position.set(...shaftPoint(-1.006));
  shaftAxis.rotation.z = Math.atan(0.265);
  const propeller = part(shaftAxis, 'Propeller');
  rod(propeller, m.bronze, [-0.045, 0, 0], [0.037, 0, 0], 0.012, 0.022, 28);
  ellipsoid(propeller, m.bronze, [-0.033, 0, 0], [0.026, 0.018, 0.018]);
  // A cupped blade surface with changing chord, pitch and skew along its radius.
  const bladeMat = m.bronze.clone();
  bladeMat.side = THREE.DoubleSide;
  for (let blade = 0; blade < 3; blade++) {
    const rows = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16,
        r = 0.014 + 0.082 * t;
      const mid = (blade * Math.PI * 2) / 3 + 0.32 * t * t;
      const half = 0.48 * Math.pow(Math.max(0.003, Math.sin(Math.PI * t)), 0.59) + 0.035 * (1 - t);
      const row = [];
      for (let j = 0; j <= 7; j++) {
        const u = (j / 7) * 2 - 1,
          angle = mid + u * half;
        const x = 0.013 * (1 - t) + u * half * r * (1.16 - 0.67 * t) + 0.003 * (1 - u * u);
        row.push([x, r * Math.cos(angle), r * Math.sin(angle)]);
      }
      rows.push(row);
    }
    mesh(propeller, gridGeometry(rows), bladeMat);
  }
  const rudder = part(root, 'Rudder');
  rudder.position.set(-1.106, -0.115, 0);
  rod(rudder, m.steel, [0, -0.016, 0], [0, 0.015, 0], 0.01);
  const rings = [
    [-0.01, 0.038, -0.066, 0.012],
    [-0.043, 0.043, -0.079, 0.012],
    [-0.169, 0.02, -0.082, 0.009],
    [-0.191, 0.001, -0.065, 0.006],
  ];
  const foil = rings.map(([y, lead, trail, w]) => [
    [lead, y, 0],
    [lead - 0.014, y, w],
    [trail + 0.015, y, w * 0.43],
    [trail, y, 0],
    [trail + 0.015, y, -w * 0.43],
    [lead - 0.014, y, -w],
  ]);
  for (let i = 0; i < foil.length - 1; i++) {
    for (let j = 0; j < 6; j++) {
      const k = (j + 1) % 6;
      mesh(rudder, polygonGeometry([foil[i][j], foil[i + 1][j], foil[i + 1][k], foil[i][k]], true), m.blue);
    }
  }
  mesh(rudder, polygonGeometry(foil[0], true), m.blue);
  mesh(rudder, polygonGeometry(foil.at(-1)), m.blue);
  return { fixed, propeller, rudder };
}

// Batch static pieces by finish within each named assembly. The two drive pivots
// keep their local axes, including when the model is exported as glTF.
function batchAssembly(group) {
  group.updateWorldMatrix(true, true);
  const inverse = group.matrixWorld.clone().invert(),
    sets = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geometry.applyMatrix4(inverse.clone().multiply(o.matrixWorld));
    if (!sets.has(o.material)) sets.set(o.material, []);
    sets.get(o.material).push(geometry);
    o.geometry.dispose();
  });
  group.clear();
  for (const [mat, geometries] of sets) {
    const combined = mergeGeometries(geometries);
    if (!mat.map) combined.deleteAttribute('uv');
    const indexed = mergeVertices(combined, 0.000001);
    combined.dispose();
    // Rounded corners can collapse to one vertex when a fitting is very thin.
    const indices = indexed.index.array;
    const triangles = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (a !== b && b !== c && c !== a) triangles.push(a, b, c);
    }
    if (triangles.length !== indices.length) indexed.setIndex(triangles);
    const o = mesh(group, indexed, mat);
    o.name = mat.name;
    o.castShadow = !mat.transparent;
    geometries.forEach((g) => g.dispose());
  }
}

export function createVessel() {
  const root = new THREE.Group();
  root.name = '水面无人艇';
  root.userData = { lengthMetres: 2.4, beamMetres: 0.9, bodyAxes: 'x forward, y up, z starboard' };
  const m = makeMaterials();
  const hull = part(root, 'Shallow-V hull'),
    deck = part(root, 'Deck hardware');
  const pod = part(root, 'Electronics enclosure'),
    mast = part(root, 'Survey mast and optics');
  buildHull(hull, m);
  buildDeck(deck, m);
  buildPod(pod, m);
  buildMast(mast, m);
  const { fixed, propeller, rudder } = buildDrive(root, m);
  [hull, deck, pod, mast, fixed, propeller, rudder].forEach(batchAssembly);
  return { root, propeller, rudder };
}
