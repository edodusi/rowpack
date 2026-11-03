// The demo site: one box per module that went into this very bundle, sized by
// how many bytes it shipped. The data comes from the bundle database itself
// (the module_sizes view), so the page draws its own build.
import {
  Scene, PerspectiveCamera, WebGLRenderer, BoxGeometry, MeshStandardMaterial, InstancedMesh,
  Object3D, Color, AmbientLight, DirectionalLight, Clock,
} from 'three/src/Three.js';

const root = document.getElementById('root');
const manifest = window.__ROWPACK_BUILD__ || fromOwnDatabase();

// On the database page this code was linked by sql.js, so it can ask the
// database it is running from which modules it is made of.
function fromOwnDatabase() {
  const db = window.__rowpackDb;
  const rows = db ? db.exec("SELECT path, bytes FROM module_sizes WHERE format = 'esm'")[0] : null;
  return { modules: rows ? rows.values.map(([path, bytes]) => ({ path, bytes })) : [] };
}

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
root.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x0d1117);
const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);

scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 60, 40);
scene.add(sun);

// a square grid, one cell per module
const mods = manifest.modules;
const side = Math.ceil(Math.sqrt(mods.length || 1));
const maxBytes = Math.max(1, ...mods.map((m) => m.bytes));
const mesh = new InstancedMesh(new BoxGeometry(0.8, 1, 0.8), new MeshStandardMaterial({ roughness: 0.5 }), Math.max(1, mods.length));
const dummy = new Object3D();
const color = new Color();
const heights = mods.map((m) => 0.2 + 12 * Math.sqrt(m.bytes / maxBytes));
mods.forEach((m, i) => {
  color.setHSL(m.path.includes('/renderers/') ? 0.58 : m.path.includes('/math/') ? 0.33 : 0.08, 0.7, 0.55);
  mesh.setColorAt(i, color);
});
scene.add(mesh);
camera.position.set(side * 0.9, side * 0.8, side * 0.9);
camera.lookAt(0, 0, 0);

// drag to orbit, no addons (addons import 'three' and would pull in a second copy)
let angle = Math.PI / 4;
let dragging = false;
let lastX = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  angle -= (e.clientX - lastX) * 0.005;
  lastX = e.clientX;
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock = new Clock();
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  const grow = reduceMotion ? 1 : Math.min(1, t / 2);
  mods.forEach((_, i) => {
    const x = (i % side) - side / 2;
    const z = Math.floor(i / side) - side / 2;
    const h = heights[i] * grow;
    dummy.position.set(x, h / 2, z);
    dummy.scale.set(1, h, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (!dragging && !reduceMotion) angle += 0.0015;
  const r = side * 1.45;
  camera.position.set(Math.cos(angle) * r, side * 1.05, Math.sin(angle) * r);
  camera.lookAt(0, 3, 0);
  renderer.render(scene, camera);
});

console.log(`> ${mods.length} modules drawn`);
