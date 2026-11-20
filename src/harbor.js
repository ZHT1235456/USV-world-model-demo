import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createVessel } from './vessel.js';
import { makeOcean } from './ocean.js';
import { gateBands, gatePostRadius, raftBand, raftRadius, randomSource } from './courses.js';
import { chartBeacons, chartGuides, cameraForward, cameraHeight, sensorFov, sensorHeight, sensorWidth } from './optics.js';
import { addSurroundingBanks, createHarborConcrete, quayBlock } from './surroundings.js';

const skyHorizon = new THREE.Color(0xe6cbb4);
const skyZenith = new THREE.Color(0x75a7cc);
const sunrise = new THREE.Vector3(0.58, 0.22, -0.79).normalize();
const warm = new THREE.Color(0xffd2a1);
const displayLayer = 1;
const sensorLayer = 2;

function finish(color, roughness = 0.72, metalness = 0.06) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function add(parent, geometry, material, x, y, z) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
function box(parent, material, x, y, z, length, height, depth) {
  const mesh = add(parent, unitBox, material, x, y, z);
  mesh.scale.set(length, height, depth);
  return mesh;
}

function cylinder(parent, material, x, y, z, radius, height, segments = 16, lower = radius) {
  return add(parent, new THREE.CylinderGeometry(radius, lower, height, segments), material, x, y, z);
}

function skyDome() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      horizon: { value: skyHorizon },
      zenith: { value: skyZenith },
      sun: { value: sunrise.clone() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 ray;
      void main() {
        ray = position;
        vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = clip.xyww;
      }`,
    fragmentShader: `
      varying vec3 ray;
      uniform vec3 horizon, zenith, sun;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p);
        f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);
      }
      void main() {
        vec3 view = normalize(ray);
        float high = smoothstep(-.06, .57, view.y);
        vec3 color = mix(horizon, zenith, high);
        float toward = max(0., dot(sun, view));
        color += vec3(.50,.27,.10) * (pow(toward, 12.)*.52 + pow(toward, 110.)*.39);
        vec2 cloudCoord = view.xz * 2.55 / (max(.045,view.y) + .062);
        vec2 warp = vec2(noise(.62*cloudCoord+5.),noise(.55*cloudCoord-3.2));
        float cloud = .59*noise(cloudCoord+warp*.76)
          + .27*noise(cloudCoord*2.3-3.4) + .14*noise(cloudCoord*5.7+2.);
        float wisps = smoothstep(.49,.78,cloud)*smoothstep(.07,.21,view.y)*(1.-smoothstep(.50,.88,view.y));
        color = mix(color, vec3(.79,.81,.79)+vec3(.16,.07,.03)*toward, wisps*.54);
        color += vec3(1.,.86,.61)*smoothstep(.99966,.99984,toward)*.92;
        gl_FragColor = vec4(color,1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 28, 16), material);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  return sky;
}

function sensorWater() {
  const material = new THREE.ShaderMaterial({
    uniforms: { clock: { value: 0 }, daylight: { value: 1 } },
    vertexShader: `
      varying vec3 point;
      void main() {
        point = (modelMatrix * vec4(position,1.)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
      }`,
    fragmentShader: `
      uniform float clock, daylight;
      varying vec3 point;
      void main() {
        vec3 eye = normalize(cameraPosition-point);
        float wave = sin(point.x*5.1+sin(point.z*1.9)-clock*2.1) * sin(point.z*4.3+clock*1.22);
        float roll = sin(point.x*1.4-point.z*2.1+clock*.9);
        float haze = pow(1.-max(0.,eye.y),4.);
        vec3 color = mix(vec3(.033,.123,.158),vec3(.25,.36,.40),haze*.72);
        color += (wave*.013 + roll*.021)*vec3(.52,.89,1.);
        color += vec3(.19,.098,.04)*pow(max(0.,dot(normalize(vec3(eye.x,-eye.y,eye.z)),normalize(vec3(-.58,-.22,.79)))),33.);
        gl_FragColor = vec4(color*daylight,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(190, 190), material);
  water.position.set(19, 0, 0);
  water.rotation.x = -Math.PI / 2;
  water.layers.set(sensorLayer);
  return water;
}

function createMark(scene, mark, trim) {
  const group = new THREE.Group();
  group.position.set(mark.north, 0, mark.east);
  scene.add(group);
  const paint = finish(mark.color, 0.39, 0.18);
  // A stable color code in the camera image identifies each fixed buoy.
  const stripe = new THREE.MeshBasicMaterial({ color: mark.band, toneMapped: false, fog: false });
  cylinder(group, trim, 0, 0.042, 0, 0.303, 0.105, 32);
  cylinder(group, paint, 0, 0.14, 0, 0.257, 0.22, 28, 0.300);
  cylinder(group, stripe, 0, 0.285, 0, 0.242, 0.078, 28, 0.26);
  cylinder(group, paint, 0, 0.369, 0, 0.19, 0.10, 24, 0.24);
  const stalk = cylinder(group, paint, 0, 0.58, 0, 0.034, 0.36, 12, 0.071);
  stalk.rotation.y = mark.id;
  cylinder(group, trim, 0, 0.79, 0, 0.10, 0.048, 12);
  const lantern = new THREE.MeshBasicMaterial({ color: mark.band, toneMapped: false });
  cylinder(group, lantern, 0, 0.749, 0, 0.07, 0.062, 12);
}

function createRaft() {
  const raft = new THREE.Group();
  const rubber = finish(0x30383a, 0.88);
  const marker = new THREE.MeshBasicMaterial({ color: raftBand, toneMapped: false, fog: false });
  cylinder(raft, rubber, 0, .035, 0, raftRadius, .16, 48);
  cylinder(raft, marker, 0, .19, 0, raftRadius, .19, 48);
  const deck = finish(0xa18b63, .91);
  for (let i = -4; i <= 4; i++) {
    const d = i * .177;
    const length = 2 * Math.sqrt(.865 ** 2 - d ** 2);
    box(raft, deck, 0, .298, d, length, .039, .167);
  }
  for (const d of [-.47, .47]) {
    const cleat = finish(0x4a5051, .59, .29);
    box(raft, cleat, d, .333, 0, .23, .045, .09);
  }
  return raft;
}

function releaseGeometry(group) {
  const resources = new Set();
  group.traverse((object) => {
    if (object.isInstancedMesh) object.dispose();
    if (object.geometry) resources.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}

function guideSigns(course) {
  const group = new THREE.Group();
  const steel = finish(0x394750, 0.64, 0.22);
  const plate = finish(0x1e313d, 0.7, 0.12);
  const face = new THREE.MeshBasicMaterial({ color: 0xffd994, side: THREE.DoubleSide, toneMapped: false });
  const shape = new THREE.Shape();
  shape.moveTo(-1.11, -0.13);
  shape.lineTo(0.32, -0.13);
  shape.lineTo(0.32, -0.32);
  shape.lineTo(1.12, 0);
  shape.lineTo(0.32, 0.32);
  shape.lineTo(0.32, 0.13);
  shape.lineTo(-1.11, 0.13);
  shape.closePath();
  const glyph = new THREE.ShapeGeometry(shape);
  const sign = new THREE.BoxGeometry(2.56, 0.78, 0.075);
  const lens = new THREE.SphereGeometry(0.20, 14, 10);
  for (const guide of chartGuides(course)) {
    const { north, east, height, side } = guide;
    for (const support of [-0.92, 0.92]) {
      box(group, steel, north + support, 1.21, east + 0.23 * side, 0.095, 0.68, 0.12);
    }
    add(group, sign, plate, north, height, east + 0.21 * side);
    add(group, glyph, face, north, height, east + 0.166 * side);
    for (const anchor of guide.anchors) {
      const color = new THREE.Color().setRGB(...anchor.rgb.map((v) => v / 255), THREE.SRGBColorSpace);
      const pin = add(group, lens, new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false }),
        anchor.north, anchor.height, anchor.east);
      pin.layers.set(sensorLayer);
    }
  }
  return group;
}

function buildQuays(scene, detailed, course) {
  const { bank: wallSide, center, gate: exit, marks } = course;
  const far = exit.north + 9;
  const concrete = createHarborConcrete();
  const cap = finish(0xa7a395, .79);
  const trim = finish(0x263139);
  const dockMetal = finish(0x7c7466, .57, .37);
  const joints = finish(0x696b61, .96);
  const capStone = new RoundedBoxGeometry(3.823, .151, .58, 2, .025);
  for (const side of [-1, 1]) {
    quayBlock(scene, concrete, (far - 14.5) / 2, .21, center + side * (wallSide + 1.65), far + 14.5, 1.35, 3.3);
    for (let n = -12.55; n < far; n += 3.85) {
      add(scene, capStone, cap, n, .94, center + side * (wallSide + .235));
      box(scene, joints, n - 1.918, .49, center + side * (wallSide - .009), .017, .77, .013);
    }
    if (detailed) {
      const displayStart = scene.children.length;
      const rubber = finish(0x282c2a, .98, .02);
      const tire = new THREE.TorusGeometry(.235, .062, 9, 20);
      const equipment = randomSource(side < 0 ? 327 : 392);
      for (let n = -12; n < far; n += 2.8 + equipment() * 1.05) {
        const fender = add(scene, tire, rubber, n, .32 + equipment() * .095, center + side * (wallSide - .07));
        fender.scale.set(.91 + equipment() * .11, 1.04 + equipment() * .11, .86);
        fender.rotation.y = (equipment() - .5) * .17;
        if (equipment() > .42) {
          cylinder(scene, dockMetal, n + .45, 1.04, center + side * (wallSide + .44), .115, .105, 12);
          cylinder(scene, dockMetal, n + .45, 1.14, center + side * (wallSide + .44), .067, .15, 12);
          cylinder(scene, trim, n + .45, 1.224, center + side * (wallSide + .44), .100, .052, 12);
        }
      }
      for (const n of [4.0, far * .58]) {
        const face = center + side * (wallSide - .11);
        for (const offset of [-.18, .18]) cylinder(scene, dockMetal, n + offset, .50, face, .022, 1.63, 9);
        for (let rung = 0; rung < 6; rung++) box(scene, dockMetal, n, -.11 + rung * .22, face, .36, .034, .036);
      }
      for (let n = 0; n < far; n += 17.5) {
        cylinder(scene, dockMetal, n, 2.38, center + side * (wallSide + 1.7), .028, 2.83, 9, .044);
        cylinder(scene, trim, n, 1.09, center + side * (wallSide + 1.7), .09, .16, 10);
        box(scene, trim, n, 3.797, center + side * (wallSide + 1.38), 0.07, 0.047, 0.61);
        box(scene, dockMetal, n, 3.75, center + side * (wallSide + 1.09), .19, .09, .31);
        box(scene, cap, n, 3.70, center + side * (wallSide + 1.09), .15, .02, .22);
      }
      for (const object of scene.children.slice(displayStart)) object.layers.set(displayLayer);
    }
  }
  for (const { side, color } of gateBands) {
    const block = wallSide - 2.35;
    const end = center + side * (wallSide - block / 2);
    quayBlock(scene, concrete, far, .43, end, 1.46, 1.43, block);
    box(scene, cap, far - 0.06, 1.17, end, 1.54, 0.125, block + 0.03);
    const post = exit.east + side * exit.halfWidth;
    cylinder(scene, trim, exit.north, 0.44, post, gatePostRadius, 1.02, 14);
    const sleeve = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
    cylinder(scene, sleeve, exit.north, 0.83, post, gatePostRadius + 0.004, 0.34, 14);
  }
  if (detailed) {
    const banks = new THREE.Group();
    banks.position.z = center;
    addSurroundingBanks(banks, displayLayer, wallSide, concrete.bumpMap, far);
    scene.add(banks);
  }
  const bulb = new THREE.SphereGeometry(0.39, 14, 10);
  const gaugeGlass = new THREE.SphereGeometry(0.15, 14, 10);
  const gaugeMetal = finish(0x34434a, 0.49, 0.4);
  for (const mark of chartBeacons(course)) {
    const rgb = mark.rgb;
    const color = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    const post = cylinder(scene, trim, mark.north, mark.height / 2 + 0.22, mark.east, 0.041, mark.height - 0.51, 7);
    post.rotation.x = mark.east > 0 ? -0.06 : 0.06;
    const opticalMark = add(scene, bulb, new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false }), mark.north, mark.height, mark.east);
    opticalMark.layers.set(sensorLayer);
    if (detailed) {
      const housing = box(scene, gaugeMetal, mark.north, mark.height, mark.east, 0.26, 0.32, 0.37);
      housing.layers.set(displayLayer);
      const roof = box(scene, gaugeMetal, mark.north, mark.height + 0.186, mark.east, .35, .052, .44);
      roof.layers.set(displayLayer);
      const tint = new THREE.Color(0xb8ad87).lerp(color, .35);
      const lens = add(scene, gaugeGlass, finish(tint, .31, .16), mark.north - .132, mark.height, mark.east);
      lens.scale.x = .36;
      lens.layers.set(displayLayer);
    }
  }
  for (const mark of marks) createMark(scene, mark, trim);
}

function rgbCopy(raw) {
  const rgb = new Uint8Array(sensorWidth * sensorHeight * 3);
  for (let y = 0; y < sensorHeight; y++) {
    let input = (sensorHeight - 1 - y) * sensorWidth * 4;
    let output = y * sensorWidth * 3;
    for (let x = 0; x < sensorWidth; x++) {
      rgb[output++] = raw[input++];
      rgb[output++] = raw[input++];
      rgb[output++] = raw[input++];
      input++;
    }
  }
  return rgb;
}

function ribbon(points, width, y, dashed) {
  const positions = [];
  let travelled = 0;
  function quad(a, b, sx, sz) {
    positions.push(a.north + sx, y, a.east + sz, a.north - sx, y, a.east - sz, b.north - sx, y, b.east - sz,
      a.north + sx, y, a.east + sz, b.north - sx, y, b.east - sz, b.north + sx, y, b.east + sz);
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = b.north - a.north, e = b.east - a.east;
    const length = Math.hypot(n, e);
    if (length < 0.001) continue;
    const sx = -e / length * width / 2, sz = n / length * width / 2;
    if (dashed) {
      let start = 0;
      const cycle = .55;
      while (start < length - 0.0001) {
        const fraction = (travelled + start) % cycle;
        const draw = fraction < .34;
        const segment = Math.min(length - start, Math.max(.0001, (draw ? .34 : cycle) - fraction));
        if (draw) quad({ north: a.north + n * start / length, east: a.east + e * start / length },
          { north: a.north + n * (start + segment) / length, east: a.east + e * (start + segment) / length }, sx, sz);
        start += segment;
      }
    } else {
      quad(a, b, sx, sz);
    }
    travelled += length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function clearanceSegment(vessel, mark) {
  const c = Math.cos(vessel.heading), s = Math.sin(vessel.heading);
  const n = mark.north - vessel.north, e = mark.east - vessel.east;
  const along = THREE.MathUtils.clamp(n * c + e * s, -1.2, 1.2);
  const across = THREE.MathUtils.clamp(-n * s + e * c, -.45, .45);
  const near = { north: vessel.north + along * c - across * s, east: vessel.east + along * s + across * c };
  const dn = near.north - mark.north, de = near.east - mark.east;
  const distance = Math.hypot(dn, de);
  if (distance <= mark.radius) return null;
  const edge = { north: mark.north + dn * mark.radius / distance, east: mark.east + de * mark.radius / distance };
  return { points: [near, edge], gap: distance - mark.radius };
}

export class HarborScene {
  constructor(host, captureOnly = false) {
    this.host = host;
    this.captureOnly = captureOnly;
    this.renderer = new THREE.WebGLRenderer({ antialias: !captureOnly, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xd8cabb, 0.011);
    this.scene.add(skyDome());
    this.ambient = new THREE.HemisphereLight(0xffe4cb, 0x7199b2, 1.78);
    this.sun = new THREE.DirectionalLight(0xffd2a1, 2.35);
    this.sun.position.copy(sunrise).multiplyScalar(20);
    this.scene.add(this.ambient, this.sun);
    this.raft = createRaft();
    this.scene.add(this.raft);

    Object.assign(this, createVessel());
    this.carrier = new THREE.Group();
    this.carrier.add(this.root);
    this.scene.add(this.carrier);
    this.sensor = new THREE.PerspectiveCamera(sensorFov, sensorWidth / sensorHeight, 0.026, 128);
    this.sensor.position.set(cameraForward, cameraHeight, 0);
    this.sensor.rotation.y = -Math.PI / 2;
    this.sensor.layers.enable(sensorLayer);
    this.carrier.add(this.sensor);
    this.sampleTarget = new THREE.WebGLRenderTarget(sensorWidth, sensorHeight, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    this.sampleTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.sensorWater = sensorWater();
    this.scene.add(this.sensorWater);
    const studio = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(this.renderer);
    this.room = generator.fromScene(studio, .035);
    this.scene.environment = this.room.texture;
    this.scene.environmentIntensity = 0.63;
    studio.dispose();
    generator.dispose();
    if (captureOnly) {
      this.renderer.setSize(sensorWidth, sensorHeight, false);
      return;
    }

    this.camera = new THREE.PerspectiveCamera(44, 1, .033, 180);
    this.camera.layers.enable(displayLayer);
    this.mode = 'follow';
    this.focus = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.water = makeOcean();
    this.water.position.x = 18;
    this.scene.add(this.water);
    host.prepend(this.renderer.domElement);
    this.renderer.domElement.className = 'world-canvas';
    this.ghost = this.root.clone(true);
    const ghostPaint = new THREE.MeshBasicMaterial({ color: 0xffe1aa, transparent: true, opacity: .29, depthWrite: false, toneMapped: false });
    this.ghost.traverse((child) => {
      child.layers.set(displayLayer);
      if (child.isMesh) child.material = ghostPaint;
    });
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.trail = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0x58e4de, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.forecast = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xffbf67, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.gapLine = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xffe5bb, side: THREE.DoubleSide, toneMapped: false,
    }));
    for (const trace of [this.trail, this.forecast, this.gapLine]) {
      trace.layers.set(displayLayer);
      this.scene.add(trace);
    }
    this.gapLabel = document.createElement('output');
    this.gapLabel.className = 'clearance-tag';
    this.gapLabel.hidden = true;
    host.append(this.gapLabel);
    this.gapCenter = new THREE.Vector3();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  configure(course, raft, showGuides = true) {
    if (this.course !== course) {
      if (this.port) {
        this.scene.remove(this.port);
        releaseGeometry(this.port);
      }
      this.course = course;
      this.port = new THREE.Group();
      buildQuays(this.port, !this.captureOnly, course);
      this.guides = guideSigns(course);
      this.port.add(this.guides);
      this.scene.add(this.port);
      if (this.water) this.water.position.x = course.gate.north / 2;
      this.positioned = false;
      this.gapGhost = null;
    }
    this.guides.visible = showGuides;
    this.raft.visible = Boolean(raft);
    if (raft) this.raft.position.set(raft.north, 0, raft.east);
  }

  conditions(seed) {
    const random = randomSource(seed * 7721 + 429);
    const amount = seed ? 0.86 + 0.27 * random() : 1;
    this.ambient.intensity = 1.78 * (0.94 + amount * 0.06);
    this.sun.intensity = 2.35 * amount;
    this.sun.color.copy(warm);
    this.sensorWater.material.uniforms.daylight.value = amount;
  }

  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
    this.renderer.setSize(width, height, false);
  }

  sync(s) {
    this.carrier.position.set(s.north, 0, s.east);
    this.carrier.rotation.y = -s.heading;
    this.root.position.y = 0.006 * Math.sin(s.time * 1.9);
    this.root.rotation.x = 0.012 * Math.sin(s.time * 1.31) - 0.046 * s.yawRate * s.surge;
    this.root.rotation.z = 0.007 * Math.sin(s.time * 1.07) + 0.003 * s.surge;
    this.rudder.rotation.y = s.rudder * Math.PI / 180;
    this.propeller.rotation.x = ((s.time * s.rpm * Math.PI) / 30) % (2 * Math.PI);
    this.sensorWater.material.uniforms.clock.value = s.time;
    if (this.water) {
      const uniforms = this.water.material.uniforms;
      uniforms.clock.value = s.time;
      uniforms.boat.value.set(s.north, s.east);
      uniforms.forward.value.set(Math.cos(s.heading), Math.sin(s.heading));
      uniforms.speed.value = Math.hypot(s.surge, s.sway);
      uniforms.curvature.value = s.yawRate / Math.max(.45, s.surge);
    }
  }

  renderSensor(s) {
    this.sync(s);
    this.renderer.setRenderTarget(this.sampleTarget);
    this.renderer.render(this.scene, this.sensor);
    this.renderer.setRenderTarget(null);
  }

  sample(s) {
    this.renderSensor(s);
    const pixels = new Uint8Array(sensorWidth * sensorHeight * 4);
    this.renderer.readRenderTargetPixels(this.sampleTarget, 0, 0, sensorWidth, sensorHeight, pixels);
    return rgbCopy(pixels);
  }

  async sampleAsync(s) {
    this.renderSensor(s);
    const pixels = new Uint8Array(sensorWidth * sensorHeight * 4);
    await this.renderer.readRenderTargetPixelsAsync(this.sampleTarget, 0, 0, sensorWidth, sensorHeight, pixels);
    return rgbCopy(pixels);
  }

  setView(mode) {
    this.mode = mode;
    this.positioned = false;
  }

  paths(trail, forecast) {
    for (const [line, points, width, height, dashed] of [
      [this.trail, trail, .055, .023, false], [this.forecast, forecast, .060, .030, true],
    ]) {
      line.geometry.dispose();
      line.geometry = ribbon(points, width, height, dashed);
    }
  }

  draw(s, ghost = null, settle = false, markId = null) {
    this.sync(s);
    const top = this.mode === 'top';
    this.camera.up.set(top ? 1 : 0, top ? 0 : 1, 0);
    if (top) {
      const middle = this.course.gate.north / 2;
      this.eye.set(middle, 29 + this.course.gate.north * .85, this.course.center + 0.1);
      this.look.set(middle, 0, this.course.center);
    } else {
      const c = Math.cos(s.heading), d = Math.sin(s.heading);
      const fit = Math.max(1, 1.10 / this.camera.aspect);
      const lead = THREE.MathUtils.clamp(1.9 * this.camera.aspect, 1.10, 3.25);
      this.eye.set(s.north - (4.35 * c + 2.85 * d) * fit, 1.53 + (fit - 1) * .36,
        s.east - (4.35 * d - 2.85 * c) * fit);
      this.look.set(s.north + lead * c, .53, s.east + lead * d);
    }
    const blend = settle || !this.positioned ? 1 : .095;
    this.camera.position.lerp(this.eye, blend);
    this.focus.lerp(this.look, blend);
    this.camera.lookAt(this.focus);
    this.positioned = true;
    this.ghost.visible = Boolean(ghost);
    if (ghost) {
      this.ghost.position.set(ghost.north, 0.011, ghost.east);
      this.ghost.rotation.set(0, -ghost.heading, 0);
    }
    this.showGap(ghost, markId);
    this.renderer.render(this.scene, this.camera);
  }

  showGap(ghost, markId) {
    if (!ghost || markId === null) {
      this.gapLine.visible = false;
      this.gapLabel.hidden = true;
      return;
    }
    if (this.gapGhost !== ghost || this.gapMark !== markId) {
      this.gapGhost = ghost;
      this.gapMark = markId;
      this.gap = clearanceSegment(ghost, this.course.marks.find(({ id }) => id === markId));
      if (this.gap) {
        this.gapLine.geometry.dispose();
        this.gapLine.geometry = ribbon(this.gap.points, .035, .07, false);
        this.gapLabel.textContent = this.gap.gap.toFixed(2) + ' m';
      }
    }
    this.gapLine.visible = Boolean(this.gap);
    if (!this.gap) {
      this.gapLabel.hidden = true;
      return;
    }
    this.camera.updateMatrixWorld();
    const [a, b] = this.gap.points;
    this.gapCenter.set((a.north + b.north) / 2, .15, (a.east + b.east) / 2).project(this.camera);
    const { x, y, z } = this.gapCenter;
    this.gapLabel.hidden = Math.abs(x) > .95 || Math.abs(y) > .92 || Math.abs(z) >= 1;
    this.gapLabel.style.left = (50 + x * 50) + '%';
    this.gapLabel.style.top = (50 - y * 50) + '%';
  }
}
