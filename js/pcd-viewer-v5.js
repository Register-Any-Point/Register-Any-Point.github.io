// 1) IMPORTS (ensure your bundler or <script type="module"> can find these)
import * as THREE from 'three';
import { PCDLoader } from 'PCDLoader';
import { OrbitControls } from 'OrbitControls';

// 2) SAMPLE MAP + FRAME PARAMETERS
const sampleMap = {
  partnet_78:  ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19'],
  partnet_652: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19'],
  partnet_680: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19']
};

// OUTSIDE—at module scope, create and reuse these:
const _trajSphereGeo = new THREE.SphereGeometry(0.008, 6, 4);
const _trajSphereMat = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0.35,
  vertexColors: true,    // allows per‐instance color
  // Because it's MeshBasicMaterial, it does NOT cast or receive shadows
});

const viewerParams = {
  partnet_78:  { groundHeight: -0.8, cameraY: 1.5  },
  partnet_652: { groundHeight: -0.85, cameraY: 1.5  },
  partnet_680: { groundHeight: -0.45, cameraY: 1.0  }
};

const totalFrames   = 20;    // steps per sample
const frameInterval = 40;    // ms per frame
const pauseDuration = 3000;  // ms to pause at last frame
let slowMode = true;         // toggle “slow” vs “normal” playback

// 3) HSV → RGB HELPER (unchanged)
function hsvToRgb(h, s, v) {
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r, g, b];
}

// 4) GLOBAL STATE
let isPaused = false;
let autoResample = true;
let currentFrameIdx = 0;
let playTimeoutId = null;
let currentSession = 0;         // “session stamp” to cancel stale loads/timeouts
let isSyncing = false;          // guard for OrbitControl sync
let inputState = null;
let sampledStates = [];
let allStates = [];

const globalLoader = new PCDLoader();

// --- TRAJ GLOBALS ---
let showTrajectories = false;    // tracks whether trajectories should be visible
// (Each viewer state will keep its own `trajectorySpheres` array.)

// 5) UTILITY: PICK TWO DISTINCT RANDOM SAMPLES (unchanged)
function pickTwoRandomSamples(objName) {
  const arr = sampleMap[objName];
  if (!arr || arr.length < 2) {
    console.error(`Need ≥2 samples for "${objName}".`);
    return arr.slice(0, 2);
  }
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return [copy[0], copy[1]];
}

// 6) SYNC HELPERS FOR ORBITCONTROLS (unchanged)
function syncAnglesFrom(srcControls) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const cam = srcControls.object;
    const target = srcControls.target.clone();
    const offset = new THREE.Vector3().copy(cam.position).sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);

    allStates.forEach((st) => {
      if (st.controls === srcControls) return;
      const newPos = new THREE.Vector3()
        .setFromSphericalCoords(spherical.radius, spherical.phi, spherical.theta)
        .add(st.controls.target);
      st.camera.position.copy(newPos);
      st.camera.lookAt(st.controls.target);
      st.controls.update();
    });
  } finally {
    isSyncing = false;
  }
}

// 7) INITIALIZE A STATIC INPUT VIEWER (colored by label) (unchanged)
function initInputViewer(container, objName) {
  const width  = container.clientWidth;
  const height = container.clientHeight;

  // Scene, camera, renderer
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xFCFCFC);

  const camera = new THREE.PerspectiveCamera(25, width / height, 0.1, 1000);
  camera.position.set(0, 1.4, 5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(5, 12, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 25;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  scene.add(dirLight);

  // Handle window resize
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // “Loading…” overlay
  const loading = document.createElement('div');
  loading.classList.add('loading');
  loading.innerText = 'Loading…';
  container.appendChild(loading);

  // OrbitControls (auto‐rotate + drag‐pause + sync)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2;
  controls.update();

  controls.userIsInteracting = false;
  controls.domElement.addEventListener('mousedown', () => {
    controls.userIsInteracting = true;
  });
  document.addEventListener('mouseup', () => {
    controls.userIsInteracting = false;
  });

  controls.addEventListener('start', () => {
    allStates.forEach((st) => {
      st.controls.autoRotate = false;
    });
    document.getElementById('btn-rotate').disabled = true;
  });
  controls.addEventListener('end', () => {
    const rotateBtn = document.getElementById('btn-rotate');
    const isAutoRotate = rotateBtn.innerHTML.includes(': On');
    document.getElementById('btn-rotate').disabled = false;
    if (!isAutoRotate) return;
    allStates.forEach((st) => {
      st.controls.autoRotate = true;
    });
    syncAnglesFrom(controls);
  });
  controls.addEventListener('change', () => {
    if (controls.userIsInteracting) {
      syncAnglesFrom(controls);
    }
  });

  // LOAD “pcd/${objName}/input.pcd” and build InstancedMesh of spheres
  const pcdUrl = `pcd/${objName}/input.pcd`;
  globalLoader.load(
    pcdUrl,
    (points) => {
      const geom = points.geometry;
      const posAttr = geom.attributes.position;
      const lblAttr = geom.attributes.label;

      if (!posAttr) {
        console.error(`No position attribute in ${pcdUrl}`);
        loading.innerText = 'Error';
        return;
      }

      const positions = posAttr.array;
      const N = positions.length / 3;
      const labels = lblAttr ? lblAttr.array : null;
      const sphereGeo = new THREE.SphereGeometry(0.01, 6, 4);
      const mat = new THREE.MeshStandardMaterial({
        transparent: true,
        metalness: 0.2,
        roughness: 0.4,
        depthWrite: true,
        flatShading: false
      });
      const instMesh = new THREE.InstancedMesh(sphereGeo, mat, N);
      instMesh.castShadow = true;
      instMesh.receiveShadow = false;

      const dummyMatrix = new THREE.Matrix4();
      const color = new THREE.Color();

      let maxLabel = 0;
      if (labels) {
        for (let i = 0; i < N; i++) {
          if (labels[i] > maxLabel) maxLabel = labels[i];
        }
      }

      for (let i = 0; i < N; i++) {
        const x = positions[3 * i];
        const y = positions[3 * i + 1];
        const z = positions[3 * i + 2];
        dummyMatrix.makeTranslation(x, y, z);
        instMesh.setMatrixAt(i, dummyMatrix);

        if (labels) {
          const lbl = labels[i];
          const hue = maxLabel > 0 ? (lbl / maxLabel) * 0.8 : 0;
          const hue_remap = (hue + 0.548) % 1;
          const [r, g, b] = hsvToRgb(hue_remap, 0.62, 0.46);
          color.setRGB(r, g, b);
        } else {
          color.setRGB(0.5, 0.5, 0.5);
        }
        instMesh.setColorAt(i, color);
      }

      scene.add(instMesh);
      loading.style.display = 'none';
      inputState.mesh = instMesh;

      geom.dispose();
      points.material.dispose();
    },
    () => { /* ignore progress */ },
    (err) => {
      console.error(`Error loading input PCD ${pcdUrl}:`, err);
      loading.innerText = 'Error';
    }
  );

  return {
    container,
    scene,
    camera,
    renderer,
    controls,
    mesh: null,
    isSampled: false
  };
}

// 8) INITIALIZE A “SAMPLED” VIEWER (20‐frame animation)
function initSampledViewer(container, objName, initialSampleId) {
  const width  = container.clientWidth;
  const height = container.clientHeight;

  // Scene, camera, renderer
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xFCFCFC);

  const camera = new THREE.PerspectiveCamera(25, width / height, 0.1, 1000);
  camera.position.set(0, viewerParams[objName].cameraY, 5);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 1.8);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(5, 12, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 25;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  scene.add(dirLight);

  // Ground plane
  const planeGeo = new THREE.PlaneGeometry(20, 20);
  const planeMat = new THREE.ShadowMaterial({ opacity: 0.2 });
  const ground = new THREE.Mesh(planeGeo, planeMat);
  ground.rotateX(-Math.PI / 2);
  ground.position.y = viewerParams[objName].groundHeight;
  ground.receiveShadow = true;
  scene.add(ground);

  // Handle window resize
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // “Loading…” overlay
  const loading = document.createElement('div');
  loading.classList.add('loading');
  loading.innerText = 'Loading…';
  container.appendChild(loading);

  // OrbitControls (auto‐rotate + drag‐pause + sync)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2;
  controls.update();

  controls.userIsInteracting = false;
  controls.domElement.addEventListener('mousedown', () => {
    controls.userIsInteracting = true;
  });
  document.addEventListener('mouseup', () => {
    controls.userIsInteracting = false;
  });

  controls.addEventListener('start', () => {
    allStates.forEach((st) => {
      st.controls.autoRotate = false;
    });
    document.getElementById('btn-rotate').disabled = true;
  });
  controls.addEventListener('end', () => {
    allStates.forEach((st) => {
      st.controls.autoRotate = true;
    });
    document.getElementById('btn-rotate').disabled = false;
    syncAnglesFrom(controls);
  });
  controls.addEventListener('change', () => {
    if (controls.userIsInteracting) {
      syncAnglesFrom(controls);
    }
  });

  // Prepare arrays for 20 frames
  const frameMeshes = new Array(totalFrames).fill(null);
  const framePositions = new Array(totalFrames).fill(null);
  let N_points = 0;  // will be known once frame 0 loads

  // Keep track of trajectory spheres so we can remove them later
  const trajectorySpheres = [];         // ← TRAJ

  // Assign this state’s “session stamp”
  const mySession = currentSession;

  const state = {
    container,
    scene,
    camera,
    renderer,
    controls,
    frameMeshes,
    framePositions,
    N_points,
    currentSampleId: null,
    loadingOverlay: loading,
    isSampled: true,
    session: mySession,
    trajectorySpheres             // ← TRAJ
  };

  // Helper: pick a random sample ≠ current
  function pickRandomSample() {
    const arr = sampleMap[objName];
    if (arr.length === 1) return arr[0];
    let choice;
    do {
      choice = arr[Math.floor(Math.random() * arr.length)];
    } while (choice === state.currentSampleId);
    return choice;
  }

  // Helper: build an interpolated InstancedMesh for frames (unchanged)
  function buildInterpolatedMesh(t0, t1) {
    const pos0 = state.framePositions[t0];
    const pos1 = state.framePositions[t1];
    if (!pos0 || !pos1) return null;

    const sphereGeo = new THREE.SphereGeometry(0.01, 6, 4);
    const mat = new THREE.MeshStandardMaterial({
      transparent: true,
      metalness: 0.2,
      roughness: 0.4,
      depthWrite: true,
      flatShading: false
    });

    const mesh = new THREE.InstancedMesh(sphereGeo, mat, state.N_points);
    mesh.castShadow = true;
    mesh.receiveShadow = false;

    const dummyMatrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const srcMesh = state.frameMeshes[t0];

    for (let i = 0; i < state.N_points; i++) {
      const x0 = pos0[3 * i];
      const y0 = pos0[3 * i + 1];
      const z0 = pos0[3 * i + 2];
      const x1 = pos1[3 * i];
      const y1 = pos1[3 * i + 1];
      const z1 = pos1[3 * i + 2];

      const xm = 0.5 * (x0 + x1);
      const ym = 0.5 * (y0 + y1);
      const zm = 0.5 * (z0 + z1);
      dummyMatrix.makeTranslation(xm, ym, zm);
      mesh.setMatrixAt(i, dummyMatrix);

      if (srcMesh.instanceColor) {
        const cA = srcMesh.instanceColor;
        const r = cA.getX(i);
        const g = cA.getY(i);
        const b = cA.getZ(i);
        color.setRGB(r, g, b);
      } else {
        color.setRGB(0.5, 0.5, 0.5);
      }
      mesh.setColorAt(i, color);
    }

    mesh.visible = false;
    state.scene.add(mesh);
    return mesh;
  }

  // Helper: load all frames for a sample (unchanged except return)
  async function loadSample(sampleId, showLoading = false) {
    if (state.session !== currentSession) return null;

    if (showLoading) {
      state.loadingOverlay.style.display = 'flex';
    }

    const newMeshes = new Array(totalFrames).fill(null);
    const newPositions = new Array(totalFrames).fill(null);
    let sphereGeo = null;

    for (let t = 0; t < totalFrames; t++) {
      const url = `pcd/${objName}/sample_${sampleId}/step_${t}.pcd`;

      if (state.session !== currentSession) {
        for (let k = 0; k < t; k++) {
          if (newMeshes[k]) {
            newMeshes[k].geometry.dispose();
            newMeshes[k].material.dispose();
          }
        }
        return null;
      }

      await new Promise((resolve) => {
        globalLoader.load(
          url,
          (points) => {
            const geom = points.geometry;
            const posAttr = geom.attributes.position;
            const lblAttr = geom.attributes.label;
            if (!posAttr) {
              console.error(`No position attribute in ${url}`);
              newMeshes[t] = null;
              newPositions[t] = null;
              resolve();
              return;
            }

            const positions = posAttr.array;
            const N = positions.length / 3;
            if (t === 0) {
              state.N_points = N;
            }
            newPositions[t] = new Float32Array(positions);

            if (!sphereGeo) sphereGeo = new THREE.SphereGeometry(0.01, 6, 4);
            const mat = new THREE.MeshStandardMaterial({
              transparent: true,
              metalness: 0.2,
              roughness: 0.4,
              depthWrite: true,
              flatShading: false
            });
            const instMesh = new THREE.InstancedMesh(sphereGeo, mat, N);
            instMesh.castShadow = true;
            instMesh.receiveShadow = false;

            const dummyMatrix = new THREE.Matrix4();
            const color = new THREE.Color();

            let maxLabel = 0;
            if (lblAttr) {
              for (let i = 0; i < N; i++) {
                if (lblAttr.array[i] > maxLabel) maxLabel = lblAttr.array[i];
              }
            }

            for (let i = 0; i < N; i++) {
              const x = positions[3 * i];
              const y = positions[3 * i + 1];
              const z = positions[3 * i + 2];
              dummyMatrix.makeTranslation(x, y, z);
              instMesh.setMatrixAt(i, dummyMatrix);

              if (lblAttr) {
                const lbl = lblAttr.array[i];
                const hue = maxLabel > 0 ? (lbl / maxLabel) * 0.8 : 0;
                const hue_remap = (hue + 0.548) % 1;
                const [r, g, b] = hsvToRgb(hue_remap, 0.62, 0.46);
                color.setRGB(r, g, b);
              } else {
                color.setRGB(0.5, 0.5, 0.5);
              }
              instMesh.setColorAt(i, color);
            }

            instMesh.visible = false;
            newMeshes[t] = instMesh;
            state.scene.add(instMesh);

            geom.dispose();
            points.material.dispose();
            resolve();
          },
          () => { /* ignore progress */ },
          (err) => {
            console.error(`Error loading ${url}:`, err);
            newMeshes[t] = null;
            newPositions[t] = null;
            resolve();
          }
        );
      });

      if (state.session !== currentSession) {
        for (let k = 0; k <= t; k++) {
          if (newMeshes[k]) {
            newMeshes[k].geometry.dispose();
            newMeshes[k].material.dispose();
          }
        }
        return null;
      }
    }

    if (state.session !== currentSession) {
      newMeshes.forEach((m) => {
        if (m) {
          m.geometry.dispose();
          m.material.dispose();
        }
      });
      return null;
    }

    if (showLoading) {
      state.loadingOverlay.style.display = 'none';

      // Dispose old frame‐meshes:
      state.frameMeshes.forEach((oldMesh) => {
        if (oldMesh) {
          state.scene.remove(oldMesh);
          oldMesh.geometry.dispose();
          oldMesh.material.dispose();
        }
      });

      // Swap in the new
      state.frameMeshes = newMeshes;
      state.framePositions = newPositions;
      state.currentSampleId = sampleId;

      const idx = currentFrameIdxMapping();
      if (idx.isOriginal && state.frameMeshes[idx.frameIndex]) {
        state.frameMeshes[idx.frameIndex].visible = true;
      }
      return null;
    } else {
      return { newMeshes, newPositions, sampleId };
    }
  }

  state.currentSampleId = initialSampleId;
  state.pickRandom = pickRandomSample;
  state.loadSample = loadSample;

  // Initially load the first sample and show frame 0
  loadSample(initialSampleId, true);

  return state;

  function currentFrameIdxMapping() {
    if (!slowMode) {
      return { isOriginal: true, frameIndex: currentFrameIdx, alpha: 0 };
    } else {
      const g = currentFrameIdx;
      if (g % 2 === 0) {
        return { isOriginal: true, frameIndex: g / 2, alpha: 0 };
      } else {
        const i0 = Math.floor(g / 2);
        const i1 = i0 + 1;
        return { isOriginal: false, frameIndex: i0, nextIndex: i1, alpha: 0.5 };
      }
    }
  }
}

// 9) TEARDOWN: CLEAR ALL VIEWERS (disposing Three.js objects)
function clearAllViewers() {
  currentSession++;           // bump session so in‐flight promises bail
  clearTimeout(playTimeoutId);

  allStates.forEach((st) => {
    // Guard: skip any state object that doesn’t have a scene
    if (!st || !st.scene) return; // ← UPDATED: avoid calling traverse on undefined

    if (st.isSampled) {
      // Remove any interpolated meshes (if still present)
    //   st.scene.traverse((obj) => {
    //     if (obj.name && obj.name.startsWith(`interp_${st.currentSampleId}_`)) {
    //       if (obj.geometry) obj.geometry.dispose();
    //       if (obj.material) obj.material.dispose();
    //       st.scene.remove(obj);
    //     }
    //   });

      // Remove each frame’s InstancedMesh
      if (Array.isArray(st.frameMeshes)) {
        st.frameMeshes.forEach((m) => {
          if (m) {
            st.scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
          }
        });
      }

      // Remove any trajectory spheres
      if (Array.isArray(st.trajectorySpheres)) {
        st.trajectorySpheres.forEach((sphere) => {
          if (sphere.geometry) sphere.geometry.dispose();
          if (sphere.material) sphere.material.dispose();
          st.scene.remove(sphere);
        });
        st.trajectorySpheres.length = 0;
      }
    } else {
      if (st.mesh) {
        st.scene.remove(st.mesh);
        if (st.mesh.geometry) st.mesh.geometry.dispose();
        if (st.mesh.material) st.mesh.material.dispose();
      }
    }

    if (st.renderer && st.renderer.domElement) {
      st.container.removeChild(st.renderer.domElement);
      st.renderer.dispose();
    }
  });

  // Also clear out the containers in the DOM
  const containerEl = document.querySelector('.viewers-container');
  if (containerEl) {
    containerEl.innerHTML = '';
  }

  inputState = null;
  sampledStates = [];
  allStates = [];
}

// 10) ADVANCE FRAMES (two sampled viewers in sync)
function advanceAllFrames(session) {
  if (session !== currentSession || sampledStates.length === 0) return;
  if (isPaused) return;

  const globalTotal = slowMode ? (totalFrames * 2 - 1) : totalFrames;
  const g = currentFrameIdx;
  const prevG = (g - 1 + globalTotal) % globalTotal;

  sampledStates.forEach((st) => {
    const prevMap = mapGlobalToLocal(prevG, st);
    const currMap = mapGlobalToLocal(g, st);

    // Hide whatever was visible at prevG:
    if (prevMap.isOriginal) {
      const oldIdx = prevMap.frameIndex;
      if (st.frameMeshes[oldIdx]) st.frameMeshes[oldIdx].visible = false;
    } else {
      const name = `interp_${st.currentSampleId}_${prevMap.frameIndex}_${prevMap.nextIndex}_${prevG}`;
      const obj = st.scene.getObjectByName(name);
      if (obj) obj.visible = false;
    }

    // Show whatever should be visible at g:
    if (currMap.isOriginal) {
      const idx = currMap.frameIndex;
      if (st.frameMeshes[idx]) st.frameMeshes[idx].visible = true;
    } else {
      const i0 = currMap.frameIndex;
      const i1 = currMap.nextIndex;
      const interpName = `interp_${st.currentSampleId}_${i0}_${i1}_${g}`;
      let mesh = st.scene.getObjectByName(interpName);
      if (!mesh) {
        mesh = buildInterpolatedMeshForState(st, i0, i1, g);
      }
      if (mesh) {
        mesh.visible = true;
      }
    }
  });

  if (g === globalTotal - 1) {
    // At the last frame: start prefetching new samples immediately
    const curr0 = sampledStates[0].currentSampleId;
    const curr1 = sampledStates[1].currentSampleId;

    let newId0;
    do {
      newId0 = sampledStates[0].pickRandom();
    } while (newId0 === curr1);

    let newId1;
    do {
      newId1 = sampledStates[1].pickRandom();
    } while (newId1 === curr0 || newId1 === newId0);

    // Kick off prefetch (showLoading=false)
    const prefetchPromise0 = sampledStates[0].loadSample(newId0, false);
    const prefetchPromise1 = sampledStates[1].loadSample(newId1, false);

    // Wait pauseDuration, then swap everything in one go
    playTimeoutId = setTimeout(async () => {
      if (session !== currentSession) return;
      const [res0, res1] = await Promise.all([prefetchPromise0, prefetchPromise1]);
      if (session !== currentSession) return;

      // For each sampled viewer, remove old trajectories & old meshes before swapping
      [res0, res1].forEach((res, i) => {
        const st = sampledStates[i];
        if (!res) return;

        // Remove & dispose ALL interpolated meshes (any name starting with 'interp_<oldSampleId>_')
        const toRemove = [];
        st.scene.traverse((obj) => {
          if (obj.name && obj.name.startsWith(`interp_${st.currentSampleId}_`)) {
            toRemove.push(obj);
          }
        });
        toRemove.forEach((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
          st.scene.remove(obj);
        });

        // Remove & dispose old frame‐meshes
        st.frameMeshes.forEach((oldMesh) => {
          if (oldMesh) {
            st.scene.remove(oldMesh);
            oldMesh.geometry.dispose();
            oldMesh.material.dispose();
          }
        });

        // ← TRAJ: Remove any trajectory spheres for the old sample
        st.trajectorySpheres.forEach((sphere) => {
          if (sphere.geometry) sphere.geometry.dispose();
          if (sphere.material) sphere.material.dispose();
          st.scene.remove(sphere);
        });
        st.trajectorySpheres.length = 0;

        // Swap in the newly-loaded frames & positions
        st.frameMeshes = res.newMeshes;
        st.framePositions = res.newPositions;
        st.currentSampleId = res.sampleId;

        // Show frame 0 of the new sample
        if (st.frameMeshes[0]) {
          st.frameMeshes[0].visible = true;
        }

        // ← TRAJ: If the toggle is ON, immediately draw new spheres for the new sample
        if (showTrajectories) {
          drawTrajectoriesForState(st);
        }
      });

      // 7) Restart from frame 0 if still playing
      if (!isPaused) {
        currentFrameIdx = 0;
        advanceAllFrames(session);
      }
    }, pauseDuration);
  } else {
    // Normal case: simply advance to g+1 after frameInterval
    playTimeoutId = setTimeout(() => {
      if (session !== currentSession) return;
      if (!isPaused) {
        currentFrameIdx = (currentFrameIdx + 1) % globalTotal;
        advanceAllFrames(session);
      }
    }, frameInterval);
  }

  // --- helper to map “global frame index” → {isOriginal, frameIndex, nextIndex, alpha} ---
  function mapGlobalToLocal(globalIdx, st) {
    if (!slowMode) {
      return { isOriginal: true, frameIndex: globalIdx, alpha: 0 };
    } else {
      if (globalIdx % 2 === 0) {
        return { isOriginal: true, frameIndex: globalIdx / 2, alpha: 0 };
      } else {
        const i0 = Math.floor(globalIdx / 2);
        const i1 = i0 + 1;
        return { isOriginal: false, frameIndex: i0, nextIndex: i1, alpha: 0.5 };
      }
    }
  }

  // Helper: build (and name) an interpolated mesh in `st` for indices (i0, i1) (unchanged)
  function buildInterpolatedMeshForState(st, i0, i1, globalIdx) {
    const name = `interp_${st.currentSampleId}_${i0}_${i1}_${globalIdx}`;
    const pos0 = st.framePositions[i0];
    const pos1 = st.framePositions[i1];
    if (!pos0 || !pos1) return null;

    const sphereGeo = new THREE.SphereGeometry(0.01, 6, 4);
    const mat = new THREE.MeshStandardMaterial({
      transparent: true,
      metalness: 0.2,
      roughness: 0.4,
      depthWrite: true,
      flatShading: false
    });
    const mesh = new THREE.InstancedMesh(sphereGeo, mat, st.N_points);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = name;

    const dummyMatrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const srcMesh = st.frameMeshes[i0];

    for (let i = 0; i < st.N_points; i++) {
      const x0 = pos0[3 * i], y0 = pos0[3 * i + 1], z0 = pos0[3 * i + 2];
      const x1 = pos1[3 * i], y1 = pos1[3 * i + 1], z1 = pos1[3 * i + 2];
      const xm = 0.5 * (x0 + x1), ym = 0.5 * (y0 + y1), zm = 0.5 * (z0 + z1);
      dummyMatrix.makeTranslation(xm, ym, zm);
      mesh.setMatrixAt(i, dummyMatrix);

      if (srcMesh.instanceColor) {
        const cA = srcMesh.instanceColor;
        const r = cA.getX(i), g = cA.getY(i), b = cA.getZ(i);
        color.setRGB(r, g, b);
      } else {
        color.setRGB(0.5, 0.5, 0.5);
      }
      mesh.setColorAt(i, color);
    }

    mesh.visible = false;
    st.scene.add(mesh);
    return mesh;
  }
}

// 11) RENDER LOOP (calls controls.update + render each scene) (unchanged)
function animateAll() {
  requestAnimationFrame(animateAll);
  allStates.forEach((st) => {
    st.controls.update();
    st.renderer.render(st.scene, st.camera);
  });
}

// 12) DRAW TRAJECTORIES FOR ONE VIEWER STATE (sampled viewer only) ← TRAJ
function drawTrajectoriesForState(st) {
  const N = st.N_points;
  if (N === 0 || !st.framePositions[0]) return;

  // 1) Pick 5% of indices at random
  const numToSample = Math.max(1, Math.floor(N * 0.075));
  const indices = new Set();
  while (indices.size < numToSample) {
    indices.add(Math.floor(Math.random() * N));
  }
  const selectedIndices = Array.from(indices);

  // 2) We will have totalInstances = numToSample * totalFrames
  const totalInstances = numToSample * totalFrames;
  const instancedMesh = new THREE.InstancedMesh(
    _trajSphereGeo,
    _trajSphereMat,
    totalInstances
  );
  // Enable per‐instance color
  instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(totalInstances * 3),
    3
  );
  instancedMesh.count = totalInstances; // yep, exactly this many
  instancedMesh.castShadow = false;
  instancedMesh.receiveShadow = false;

  // 3) Fill in each instance’s matrix and color
  const dummyMatrix = new THREE.Matrix4();
  const color = new THREE.Color();

  let instanceIdx = 0;
  for (let pi = 0; pi < selectedIndices.length; pi++) {
    const ptIdx = selectedIndices[pi];

    // Pre‐grab colorSeries[ptIdx] for all frames if you want—this avoids
    // re‐reading instanceColor on each frame. But we can just read from meshAtT.instanceColor as below.
    for (let t = 0; t < totalFrames; t++) {
      const posArr = st.framePositions[t]; // Float32Array length=N*3
      const x = posArr[3 * ptIdx];
      const y = posArr[3 * ptIdx + 1];
      const z = posArr[3 * ptIdx + 2];

      // Build translation for this instance
      dummyMatrix.makeTranslation(x, y, z);
      instancedMesh.setMatrixAt(instanceIdx, dummyMatrix);

      // Determine the color from the original instanced‐mesh at frame t
      const meshAtT = st.frameMeshes[t];
      if (meshAtT.instanceColor) {
        const cA = meshAtT.instanceColor;
        const r = cA.getX(ptIdx);
        const g = cA.getY(ptIdx);
        const b = cA.getZ(ptIdx);
        color.setRGB(r, g, b);
      } else {
        color.setRGB(0.5, 0.5, 0.5);
      }
      instancedMesh.setColorAt(instanceIdx, color);

      instanceIdx++;
    }
  }

  // Make sure the InstancedMesh knows its colors were updated
  instancedMesh.instanceColor.needsUpdate = true;
  instancedMesh.instanceMatrix.needsUpdate = true;

  // 4) Add the single InstancedMesh to the scene
  st.scene.add(instancedMesh);

  // 5) Push it into st.trajectorySpheres so the teardown logic still works
  // (Later, removeTrajectoriesForState can simply loop over trajectorySpheres,
  //  dispose geometry/material, and scene.remove(obj).)
  st.trajectorySpheres.push(instancedMesh);
}

// 13) REMOVE ALL TRAJECTORIES FOR ONE VIEWER STATE ← TRAJ
function removeTrajectoriesForState(st) {
  st.trajectorySpheres.forEach((sphere) => {
    if (sphere.geometry) sphere.geometry.dispose();
    if (sphere.material) sphere.material.dispose();
    st.scene.remove(sphere);
  });
  st.trajectorySpheres.length = 0;
}

// 14) BUILD VIEWERS WHEN A TAB IS CLICKED
function selectObject(objName) {
  // 1) Tear down anything from the last session
  clearAllViewers();

  // 2) Mark active tab
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.obj === objName);
  });

  // 3) Increment session so old loads/timeouts bail
  currentSession++;

  const vc = document.querySelector('.viewers-container');

  // A) “Condition / Unposed Part Point Clouds” (static input)
  const inputWrapper = document.createElement('div');
  inputWrapper.style.display = 'flex';
  inputWrapper.style.flexDirection = 'column';
  inputWrapper.style.alignItems = 'center';

  const inputCaption = document.createElement('div');
  inputCaption.classList.add('viewer-caption');
  inputCaption.innerHTML =
    'Condition<hr><span class="viewer-subcaption">Unposed Part Point Clouds</span>';
  inputWrapper.appendChild(inputCaption);

  const inputDiv = document.createElement('div');
  inputDiv.classList.add('viewer');
  inputDiv.id = `input-viewer`;
  // inputDiv.style.border = '1px solid #ccc';
  inputDiv.style.borderRadius = '8px';
  inputDiv.style.marginTop = '15px';
  inputDiv.style.flex = '1 1 280px';
  inputWrapper.appendChild(inputDiv);

  vc.appendChild(inputWrapper);
  inputState = initInputViewer(inputDiv, objName);

  // B) “Generation / Possible Assembled Point Clouds” (two sampled viewers)
  const assembledBlock = document.createElement('div');
  assembledBlock.style.display = 'flex';
  assembledBlock.style.flexDirection = 'column';

  const assembledCaption = document.createElement('div');
  assembledCaption.classList.add('assembled-caption');
  assembledCaption.innerHTML =
    'Generation<hr><span class="assembled-subcaption">Possible Assembled Point Clouds</span>';
  assembledBlock.appendChild(assembledCaption);

  const twoWrap = document.createElement('div');
  twoWrap.classList.add('assembled-container');

  // First sampled viewer
  const sampleWrapper1 = document.createElement('div');
  sampleWrapper1.style.display = 'flex';
  sampleWrapper1.style.flexDirection = 'column';
  sampleWrapper1.style.alignItems = 'center';

  const sampleDiv1 = document.createElement('div');
  sampleDiv1.classList.add('viewer');
  sampleDiv1.style.flex = '1 1 280px';
  sampleWrapper1.appendChild(sampleDiv1);

  twoWrap.appendChild(sampleWrapper1);

  // Second sampled viewer
  const sampleWrapper2 = document.createElement('div');
  sampleWrapper2.style.display = 'flex';
  sampleWrapper2.style.flexDirection = 'column';
  sampleWrapper2.style.alignItems = 'center';

  const sampleDiv2 = document.createElement('div');
  sampleDiv2.classList.add('viewer');
  sampleDiv2.style.flex = '1 1 280px';
  sampleWrapper2.appendChild(sampleDiv2);

  twoWrap.appendChild(sampleWrapper2);

  assembledBlock.appendChild(twoWrap);
  vc.appendChild(assembledBlock);

  // Initialize the two sampled viewers with two random sample IDs
  const [id1, id2] = pickTwoRandomSamples(objName);
  const state1 = initSampledViewer(sampleDiv1, objName, id1);
  const state2 = initSampledViewer(sampleDiv2, objName, id2);
  sampledStates = [state1, state2];
  allStates = [inputState, state1, state2];

  // ← NEW: Whenever we switch objects, force‐resume playback + rotation + disable trajectories
  isPaused = false; // ensure we’re playing
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) {
    pauseBtn.innerText = 'Pause';
  }

  const rotateBtn = document.getElementById('btn-rotate');
  if (rotateBtn) {
    // Restore rotation to “On”
    rotateBtn.innerText = 'Rotate: On';
  }
  // Actually enable autoRotate on every viewer’s OrbitControls
  allStates.forEach((st) => {
    if (st.controls) st.controls.autoRotate = true;
  });

  showTrajectories = false; // disable any lingering trajectories
  const trajBtn = document.getElementById('btn-traj');
  if (trajBtn) {
    trajBtn.innerText = 'Trajectories: Off';
  }

  // Reset frame index & begin animation/resampling loop
  currentFrameIdx = 0;
  advanceAllFrames(currentSession);
}

// 15) HOOK UP TAB BUTTONS + TOGGLE BUTTONS ONCE DOM IS READY
window.addEventListener('DOMContentLoaded', () => {
  // Tab buttons:
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectObject(btn.dataset.obj);
    });
  });

  // “Rotate” button toggles autoRotate:
  const rotateBtn = document.getElementById('btn-rotate');
  rotateBtn.addEventListener('click', () => {
    const anyAuto = allStates.some((st) => st.controls?.autoRotate);
    if (anyAuto) {
      allStates.forEach((st) => {
        if (st.controls) st.controls.autoRotate = false;
      });
    } else {
      allStates.forEach((st) => {
        if (st.controls) st.controls.autoRotate = true;
      });
    }
    // Enable the button again (in case it was disabled during drag)
    rotateBtn.disabled = false;

    const anyAuto2 = allStates.some((st) => st.controls?.autoRotate);
    rotateBtn.innerText = anyAuto2
      ? 'Rotate: On'
      : 'Rotate: Off';
  });

  // “Show Trajectories” button (toggle):
  const trajBtn = document.getElementById('btn-traj');
  trajBtn.innerText = 'Trajectories: Off';     // initially off
  trajBtn.addEventListener('click', () => {
    showTrajectories = !showTrajectories;
    if (showTrajectories) {
      trajBtn.innerText = 'Trajectories: On';
      // Draw trajectories for each sampled viewer if frames are already loaded:
      sampledStates.forEach((st) => {
        const allLoaded = st.framePositions.every((arr) => arr !== null);
        if (allLoaded) {
          drawTrajectoriesForState(st);
        }
      });
    } else {
      trajBtn.innerText = 'Trajectories: Off';
      // Remove any existing trajectories
      sampledStates.forEach((st) => {
        removeTrajectoriesForState(st);
      });
    }
  });

  // ← UPDATED: “Play/Pause” button wiring (now also stops/starts autoRotate)
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) {
    pauseBtn.innerText = 'Pause';    // default: playing
    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;

      if (isPaused) {
        // 1) Switch button label
        pauseBtn.innerText = 'Play';
        // 2) Stop the frame‐advance loop
        clearTimeout(playTimeoutId);
        // 3) Force all viewers to stop rotating
        allStates.forEach((st) => {
          if (st.controls) st.controls.autoRotate = false;
        });
      } else {
        // 1) Switch button label
        pauseBtn.innerText = 'Pause';
        // 2) Restore autoRotate only if "Rotate" is currently set to On:
        const rotateIsOn = rotateBtn.innerText.includes('On');
        allStates.forEach((st) => {
          if (st.controls) st.controls.autoRotate = rotateIsOn;
        });
        // 3) Re‐start frame‐advance from the current frame
        advanceAllFrames(currentSession);
      }
    });
  }

  // Show the first object by default
  selectObject('partnet_652');

  // Start the render loop
  animateAll();
});