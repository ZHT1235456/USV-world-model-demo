import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

// Periodic slopes from a directional wave spectrum. The same tile can be sampled
// at several moving scales without a network texture or seams at the boundaries.
function rippleTexture() {
  const size = 256,
    data = new Uint8Array(size * size * 4),
    bands = [];
  let seed = 419;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 34; i++) {
    const f = 1.8 * Math.pow(1.082, i);
    const angle = 0.86 + (random() - 0.5) * 2.1;
    const kx = Math.round(f * Math.cos(angle)),
      kz = Math.round(f * Math.sin(angle));
    const norm = Math.hypot(kx, kz);
    bands.push([kx, kz, kx / norm, kz / norm, random() * 6.283, (0.3 + 0.3 * random()) / Math.pow(f, 0.31)]);
  }
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2,
        v = (z / size) * Math.PI * 2;
      let sx = 0,
        sz = 0,
        h = 0;
      const bend = 0.56 * Math.sin(u + v) + 0.32 * Math.sin(2 * u - v);
      for (const [kx, kz, dx, dz, phase, amp] of bands) {
        const a = kx * u + kz * v + phase + bend,
          c = amp * Math.cos(a);
        sx += c * dx;
        sz += c * dz;
        h += amp * Math.sin(a);
      }
      const i = (z * size + x) * 4;
      data[i] = 128 + Math.round(Math.tanh(sx * 0.76) * 126);
      data[i + 1] = 128 + Math.round(Math.tanh(sz * 0.76) * 126);
      data[i + 2] = 128 + Math.round(Math.tanh(h * 0.7) * 126);
      data[i + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export function makeOcean() {
  const shader = {
    name: 'Trial water surface',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      ripples: { value: null },
      clock: { value: 0 },
      travel: { value: new THREE.Vector2() },
      boat: { value: new THREE.Vector2() },
      lightDirection: { value: new THREE.Vector3(0.58, 0.22, -0.79).normalize() },
      forward: { value: new THREE.Vector2(1, 0) },
      speed: { value: 0 },
      curvature: { value: 0 },
    },
    vertexShader: [
      'uniform mat4 textureMatrix;',
      'varying vec4 mirrorUv; varying vec3 waterPoint;',
      'void main(){',
      '  mirrorUv=textureMatrix*vec4(position,1.);',
      '  waterPoint=(modelMatrix*vec4(position,1.)).xyz;',
      '  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);',
      '}',
    ].join('\n'),
    fragmentShader: waterFragment,
  };
  const water = new Reflector(new THREE.PlaneGeometry(260, 260), {
    textureWidth: 768,
    textureHeight: 512,
    multisample: 0,
    clipBias: 0.002,
    shader,
  });
  water.rotation.x = -Math.PI / 2;
  water.layers.set(1);
  water.material.uniforms.ripples.value = rippleTexture();
  return water;
}

const waterFragment = /* glsl */ `
  uniform sampler2D ripples, tDiffuse;
  uniform vec2 travel, forward, boat;
  uniform vec3 lightDirection;
  uniform float clock, speed, curvature;
  varying vec4 mirrorUv;
  varying vec3 waterPoint;
  void main(){
    vec2 p=waterPoint.xz + travel;
    float t=clock;
    vec3 broad=texture2D(ripples,p*.177+vec2(t*.012,-t*.009)).rgb*2.-1.;
    mat2 rot=mat2(.835,.55,-.55,.835);
    vec3 ripple=texture2D(ripples,rot*p*.482+vec2(-t*.024,t*.014)+broad.rg*.052).rgb*2.-1.;
    vec3 fine=texture2D(ripples,rot*rot*p*1.41+vec2(t*.036,t*.011)+ripple.rg*.039).rgb*2.-1.;
    vec3 capillary=texture2D(ripples,rot*p*3.06+vec2(-t*.042,t*.036)+fine.rg*.021).rgb*2.-1.;
    vec2 slope=broad.rg*.150 + ripple.rg*.115 + fine.rg*.078 + capillary.rg*.036;
    vec3 eye=normalize(cameraPosition-waterPoint);
    vec3 normal=normalize(vec3(slope.x,1.,slope.y));
    vec3 ray=reflect(-eye,normal);
    vec3 light=lightDirection;
    float incidence=clamp(dot(normal,eye),0.,1.);
    float fresnel=.028+.51*pow(1.-incidence,3.);
    float roll=.5+.5*sin(p.x*.83+p.y*1.31+broad.b*.9+t*.19);
    vec3 base=mix(vec3(.009,.065,.091),vec3(.023,.135,.166),roll*.65+.32);
    vec3 sky=mix(vec3(.46,.56,.57),vec3(.10,.28,.43),smoothstep(-.09,.68,ray.y));
    float band=dot(normal,light);
    vec3 surface=base*(.68+band*.42+broad.b*.115+ripple.b*.062);
    surface=mix(surface,sky,fresnel+.032);
    float sun=max(dot(ray,light),0.);
    surface+=vec3(1.25,.75,.36)*(.06*pow(sun,18.)+.51*pow(sun,125.)+1.34*pow(sun,395.));
    float crease=pow(clamp(dot(slope,vec2(-.65,.76))*2.9+.38,0.,1.),4.);
    surface+=vec3(.019,.053,.061)*crease*(.65+.35*capillary.b);
    vec2 mirror=mirrorUv.xy/mirrorUv.w+slope*.034/max(.65,mirrorUv.w*.23);
    vec3 reflected=texture2D(tDiffuse,clamp(mirror,.001,.999)).rgb;
    surface=mix(surface,reflected,clamp(.031+fresnel*.35,0.,.38));

    // Hull-relative wake with a curved centreline and two diverging shoulders.
    vec2 nearBoat=waterPoint.xz-boat;
    vec2 hull=vec2(dot(nearBoat,forward),dot(nearBoat,vec2(-forward.y,forward.x)));
    float aft=max(-hull.x-.78,0.);
    float bend=clamp(.36*curvature*aft*aft,-aft*.45,aft*.45);
    float lateral=abs(hull.y-bend);
    float fromBow=max(1.13-hull.x,0.);
    float hullBeam=.409*(1.-exp(-fromBow*2.23));
    float run=clamp(speed/1.35,0.,1.35);
    float boundary=hullBeam+aft*.21+sin(aft*4.2+t*.81)*.012*aft;
    float edgeDist=lateral-boundary;
    float shoulder=exp(-pow(abs(edgeDist)/(.038+.052*aft),2.))
      *smoothstep(0.,.19,fromBow)*exp(-aft*.31);
    float wash=exp(-pow(lateral/(.17+.147*aft),2.))*exp(-aft*.34)
      *smoothstep(0.,.44,aft);
    float wakeRidges=.5+.5*cos((edgeDist+.026*ripple.b)*46./(1.+aft*.25));
    float sideWaves=exp(-max(edgeDist,0.)*5.)*smoothstep(.0,.12,edgeDist)
      *exp(-aft*.46)*smoothstep(.05,.7,fromBow)*wakeRidges;
    float foamNoise=clamp(.48+.33*ripple.b+.27*fine.b+.22*broad.b,0.,1.);
    float bubbles=smoothstep(.39,.78,foamNoise);
    float foam=clamp(run*(shoulder*(.24+.67*bubbles)+wash*(.19+.61*bubbles)+sideWaves*.14),0.,.93);
    float contact=exp(-pow(abs(hull.x+.035)/1.26,4.)-pow(abs(hull.y)/.471,4.));
    surface*=1.-.56*contact;
    surface=mix(surface,vec3(.56,.79,.76),foam);
    surface=mix(surface,sky,smoothstep(40.,118.,length(waterPoint-cameraPosition))*.67);
    gl_FragColor=vec4(surface,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
