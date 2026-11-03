// three.js from source: fewer modules, much more code per module.
import * as THREE from 'three/src/Three.js';

const geometry = new THREE.BoxGeometry(1, 1, 1);
const v = new THREE.Vector3(1, 2, 3).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
console.log('>', Object.keys(THREE).length, geometry.attributes.position.count, v.toArray().map((n) => n.toFixed(3)).join(','));
if (typeof window !== 'undefined') window.__app = 'three-all';
