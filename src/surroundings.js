import * as THREE from 'three';
import { randomSource } from './mission.js';

function noiseTile(resolution, random) {
  const values = Array.from({ length: resolution * resolution }, random);
  return (u, v) => {
    const x = u * resolution;
    const y = v * resolution;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const a = x - i;
    const b = y - j;
    const s = a * a * (3 - 2 * a);
    const t = b * b * (3 - 2 * b);
    const at = (column, row) => values[(row % resolution) * resolution + column % resolution];
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(i, j), at(i + 1, j), s),
      THREE.MathUtils.lerp(at(i, j + 1), at(i + 1, j + 1), s), t);
  };
}

function texture(data, size, colorSpace = THREE.NoColorSpace) {
  const map = new THREE.DataTexture(data, size, size);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = colorSpace;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 4;
  map.needsUpdate = true;
  return map;
}

export function createHarborConcrete() {
  const size = 384;
  const rgb = new Uint8Array(size * size * 4);
  const height = new Uint8Array(rgb.length);
  const random = randomSource(3197);
  const mottling = noiseTile(7, random);
  const aggregate = noiseTile(39, random);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = mottling(x / size, y / size);
      const a = aggregate(x / size, y / size);
      const grain = random();
      const voids = a < .22 && grain < .18 ? 16 : 0;
      const value = Math.round(137 + n * 36 + a * 17 + grain * 15 - voids);
      const i = (y * size + x) * 4;
      rgb[i] = value + 6;
      rgb[i + 1] = value + 2;
      rgb[i + 2] = value - 5;
      rgb[i + 3] = 255;
      const bump = Math.round(89 + a * 43 + grain * 31 - voids * 2);
      height[i] = height[i + 1] = height[i + 2] = bump;
      height[i + 3] = 255;
    }
  }
  const albedo = texture(rgb, size, THREE.SRGBColorSpace);
  const finish = new THREE.MeshStandardMaterial({
    color: 0xe9e3d8,
    map: albedo,
    bumpMap: texture(height, size),
    bumpScale: .024,
    roughness: .91,
  });
  finish.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 quayPosition;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nquayPosition=(modelMatrix*vec4(transformed,1.)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 quayPosition;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float shore = quayPosition.x + quayPosition.z * .73;
        float stainTop = .17 + .04*sin(shore*5.3) + .025*sin(shore*13.2);
        float tide = 1.-smoothstep(stainTop-.16,stainTop+.18,quayPosition.y);
        float runs = pow(.5+.5*sin(shore*14.6+sin(shore*3.1)),6.) * (1.-smoothstep(.15,.64,quayPosition.y));
        diffuseColor.rgb *= mix(vec3(1.), vec3(.42,.50,.48), clamp(.91*tide+.23*runs,0.,1.));
      `);
  };
  return finish;
}

export function quayBlock(scene, material, x, y, z, length, height, depth) {
  const geometry = new THREE.BoxGeometry(length, height, depth);
  const uv = geometry.attributes.uv;
  const widths = [depth, depth, length, length, length, length];
  const heights = [height, height, depth, depth, height, height];
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    uv.setXY(i, uv.getX(i) * widths[face] / 1.7, uv.getY(i) * heights[face] / 1.7);
  }
  const block = new THREE.Mesh(geometry, material);
  block.position.set(x, y, z);
  scene.add(block);
}

function bankHeight(north, setback) {
  return .26 + Math.max(0, setback - .45) * .22
    + (.20 * Math.sin(north * .13) + .17 * Math.sin(north * .37 + setback)) * Math.min(1, setback / 1.5);
}

function terrain(scene, center, size, segments, elevation, colors, layer) {
  const geometry = new THREE.PlaneGeometry(size[0], size[1], segments[0], segments[1]);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(center[0], 0, center[1]);
  const position = geometry.attributes.position;
  const tones = new Float32Array(position.count * 3);
  const low = new THREE.Color(colors[0]), high = new THREE.Color(colors[1]), color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i);
    const y = elevation(x, z);
    position.setY(i, y);
    color.copy(low).lerp(high, THREE.MathUtils.clamp(.20 + y * .08 + Math.sin(x * .79 + z * .65) * .09, 0, .88));
    color.toArray(tones, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(tones, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .98 }));
  mesh.layers.set(layer);
  scene.add(mesh);
}

function fracturedStone(phase) {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const points = geometry.attributes.position;
  for (let i = 0; i < points.count; i++) {
    const x = points.getX(i), y = points.getY(i), z = points.getZ(i);
    const shape = 1 + .19 * Math.sin(x * 6.2 + z * 4.7 + phase) + .10 * Math.sin(y * 9.2 - z * 4.4 + phase);
    points.setXYZ(i, x * shape + y * .12, Math.max(-.69, y * shape), z * shape + x * .08);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function addSurroundingBanks(scene, layer, wallSide, gritMap, far) {
  const random = randomSource(38421);
  const toe = wallSide + 3.27;
  for (const side of [-1, 1]) {
    terrain(scene, [(far - 15) / 2, side * (toe + 4)], [far + 22, 8.4], [76, 15],
      (n, e) => bankHeight(n, Math.abs(e) - toe), [0x7c7665, 0x71806b], layer);
  }

  const stone = new THREE.MeshStandardMaterial({ roughness: .97, bumpMap: gritMap, bumpScale: .07 });
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let variant = 0; variant < 3; variant++) {
    const rocks = new THREE.InstancedMesh(fracturedStone(variant * 2.37), stone, 104);
    for (let i = 0; i < rocks.count; i++) {
      const side = i < rocks.count / 2 ? -1 : 1;
      const north = -15.5 + random() * (far + 17.5);
      const setback = random() ** 1.55 * 4.0;
      const size = .21 + random() ** 2.3 * 1.10;
      dummy.position.set(north, bankHeight(north, setback) + size * .22, side * (toe + setback));
      dummy.rotation.set((random() - .5) * .6, random() * Math.PI * 2, (random() - .5) * .72);
      dummy.scale.set(size * (1.05 + random() * .55), size * (.48 + random() * .23), size * (.67 + random() * .48));
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
      tint.setHSL(.08 + random() * .06, .07 + random() * .11, .34 + random() * .25, THREE.SRGBColorSpace);
      rocks.setColorAt(i, tint);
    }
    rocks.layers.set(layer);
    rocks.computeBoundingSphere();
    scene.add(rocks);
  }

  const leaf = new THREE.MeshStandardMaterial({ roughness: .97 });
  const scrub = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), leaf, 416);
  const green = new THREE.Color();
  let index = 0;
  for (let center = 0; center < 64; center++) {
    const side = center < 32 ? -1 : 1;
    const north = -16 + random() * (far + 19);
    const setback = 3.0 + random() * 4.8;
    const tuft = .26 + random() * .45;
    for (let branch = 0; branch < (center < 32 ? 7 : 6); branch++) {
      const radius = tuft * (.53 + .38 * random());
      const n = north + (random() - .5) * tuft * 2.7;
      const e = setback + (random() - .5) * tuft * 2.4;
      dummy.position.set(n, bankHeight(n, e) + radius * (.43 + random() * .55), side * (toe + e));
      dummy.rotation.set(random() * .18, random() * 6.28, random() * .23);
      dummy.scale.set(radius * 1.22, radius * (.56 + random() * .52), radius * (.72 + random() * .50));
      dummy.updateMatrix();
      scrub.setMatrixAt(index, dummy.matrix);
      green.setHSL(.18 + random() * .095, .19 + random() * .15, .23 + random() * .14, THREE.SRGBColorSpace);
      scrub.setColorAt(index, green);
      index++;
    }
  }
  scrub.layers.set(layer);
  scrub.computeBoundingSphere();
  scene.add(scrub);

  const hills = [
    { center: [119, -46], size: [73, 102], height: 6.9, phase: 1.2, colors: [0x747f74, 0x637669] },
    { center: [151, 31], size: [99, 132], height: 10.8, phase: 2.7, colors: [0x87928f, 0x74898b] },
  ];
  for (const land of hills) {
    terrain(scene, land.center, land.size, [52, 57], (x, z) => {
      const a = (x - land.center[0]) / (land.size[0] * .49);
      const b = (z - land.center[1]) / (land.size[1] * .49);
      const edge = Math.max(0, 1 - a * a - b * b);
      const shape = .64 + .19 * Math.sin(z * .16 + x * .09 + land.phase)
        + .12 * Math.sin(z * .41 - x * .12) + .07 * Math.sin((x - z) * .53);
      return -.8 + edge ** 1.4 * land.height * shape;
    }, land.colors, layer);
  }
}
