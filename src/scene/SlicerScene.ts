import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { K2_SE_PROFILE } from "../../shared/profile";

export type TransformMode = "translate" | "rotate" | "scale";

export interface Vec3Snapshot {
  x: number;
  y: number;
  z: number;
}

export interface ModelSnapshot {
  id: string;
  name: string;
  color: string;
  selected: boolean;
  triangleCount: number;
  dimensions: Vec3Snapshot;
  position: Vec3Snapshot;
  rotation: Vec3Snapshot;
  scale: Vec3Snapshot;
  valid: boolean;
  warnings: string[];
}

interface ModelEntry {
  id: string;
  name: string;
  object: THREE.Object3D;
  color: THREE.Color;
}

const PLATE = K2_SE_PROFILE.buildVolume;
const COLORS = ["#f97316", "#14b8a6", "#ef4444", "#3b82f6", "#eab308", "#a855f7", "#22c55e"];
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const MAX_MODEL_FILE_BYTES = 150 * 1024 * 1024;
const MAX_PREVIEW_VERTICES = 4_000_000;

export class SlicerScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly models = new Map<string, ModelEntry>();
  private readonly onChange: (models: ModelSnapshot[], selectedId: string | null) => void;
  private readonly onError: (message: string | null) => void;
  private selectedId: string | null = null;
  private frame = 0;
  private downPoint: { x: number; y: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    onChange: (models: ModelSnapshot[], selectedId: string | null) => void,
    onError: (message: string | null) => void,
  ) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.onError = onError;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(245, -285, 175);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 0, 35);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.screenSpacePanning = false;
    this.orbit.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setMode("translate");
    this.transform.setSpace("local");
    this.transform.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !event.value;
    });
    this.transform.addEventListener("objectChange", () => {
      const entry = this.selectedEntry();
      if (entry) {
        this.keepAbovePlate(entry.object);
        this.sync();
      }
    });
    this.scene.add(this.transform.getHelper());

    this.setupScene();
    this.bindEvents();
    this.resize();
    this.animate();
    this.sync();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("resize", this.resize);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.transform.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  async loadFile(file: File): Promise<void> {
    if (file.size === 0) {
      throw new Error(`${file.name} is empty.`);
    }
    if (file.size > MAX_MODEL_FILE_BYTES) {
      throw new Error(`${file.name} is larger than the 150 MB browser preview limit.`);
    }

    const ext = file.name.toLowerCase().split(".").pop();
    const buffer = await file.arrayBuffer();
    let object: THREE.Object3D;

    if (ext === "stl") {
      const geometry = new STLLoader().parse(buffer);
      object = new THREE.Mesh(geometry, this.createMaterial(this.models.size));
      this.validateModel(object, file.name);
      geometry.computeVertexNormals();
    } else if (ext === "3mf") {
      object = new ThreeMFLoader().parse(buffer);
      this.validateModel(object, file.name);
      this.prepareMaterials(object, this.models.size);
    } else {
      throw new Error("Only STL and 3MF files are supported.");
    }

    this.normalizeObject(object);
    const id = crypto.randomUUID();
    const color = new THREE.Color(COLORS[this.models.size % COLORS.length]);
    object.userData.modelId = id;
    object.traverse((child) => {
      child.userData.modelId = id;
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    this.models.set(id, {
      id,
      name: file.name,
      object,
      color,
    });
    this.scene.add(object);
    this.centerObject(object);
    this.selectModel(id);
    this.focusObject(object);
    this.sync();
  }

  setMode(mode: TransformMode): void {
    this.transform.setMode(mode);
  }

  selectModel(id: string | null): void {
    this.selectedId = id && this.models.has(id) ? id : null;
    const entry = this.selectedEntry();
    if (entry) {
      this.transform.attach(entry.object);
    } else {
      this.transform.detach();
    }
    this.sync();
  }

  updateSelectedTransform(update: {
    position?: Partial<Vec3Snapshot>;
    rotationDeg?: Partial<Vec3Snapshot>;
    scale?: Partial<Vec3Snapshot>;
  }): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    const { object } = entry;

    if (update.position) {
      object.position.set(
        update.position.x ?? object.position.x,
        update.position.y ?? object.position.y,
        update.position.z ?? object.position.z,
      );
    }
    if (update.rotationDeg) {
      object.rotation.set(
        (update.rotationDeg.x ?? object.rotation.x * DEG) * RAD,
        (update.rotationDeg.y ?? object.rotation.y * DEG) * RAD,
        (update.rotationDeg.z ?? object.rotation.z * DEG) * RAD,
      );
    }
    if (update.scale) {
      object.scale.set(
        update.scale.x ?? object.scale.x,
        update.scale.y ?? object.scale.y,
        update.scale.z ?? object.scale.z,
      );
    }

    this.keepAbovePlate(object);
    this.sync();
  }

  centerSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.centerObject(entry.object);
    this.sync();
  }

  focusSelected(): void {
    const entry = this.selectedEntry();
    if (entry) this.focusObject(entry.object);
  }

  layFlatSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;

    const object = entry.object;
    const originalRotation = object.rotation.clone();
    const candidates: { rotation: THREE.Euler; height: number; overflow: number }[] = [];

    for (const x of [0, 90, 180, 270]) {
      for (const y of [0, 90, 180, 270]) {
        for (const z of [0, 90, 180, 270]) {
          object.rotation.set(x * RAD, y * RAD, z * RAD);
          object.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(object);
          const size = box.getSize(new THREE.Vector3());
          const overflow =
            Math.max(0, size.x - PLATE.x) +
            Math.max(0, size.y - PLATE.y) +
            Math.max(0, size.z - PLATE.z);
          candidates.push({
            rotation: object.rotation.clone(),
            height: size.z,
            overflow,
          });
        }
      }
    }

    object.rotation.copy(originalRotation);
    candidates.sort((a, b) => a.overflow - b.overflow || a.height - b.height);
    object.rotation.copy(candidates[0].rotation);
    this.keepAbovePlate(object);
    this.centerObject(object);
    this.sync();
  }

  resetSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    entry.object.position.set(0, 0, 0);
    entry.object.rotation.set(0, 0, 0);
    entry.object.scale.set(1, 1, 1);
    this.centerObject(entry.object);
    this.sync();
  }

  duplicateSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;

    const id = crypto.randomUUID();
    const object = entry.object.clone(true);
    const color = new THREE.Color(COLORS[this.models.size % COLORS.length]);
    object.position.x += 15;
    object.position.y += 15;
    object.userData.modelId = id;
    object.traverse((child) => {
      child.userData.modelId = id;
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = this.createMaterial(this.models.size);
      }
    });

    this.models.set(id, {
      id,
      name: `${entry.name.replace(/\.(stl|3mf)$/i, "")} copy.stl`,
      object,
      color,
    });
    this.scene.add(object);
    this.selectModel(id);
    this.sync();
  }

  deleteSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.transform.detach();
    this.scene.remove(entry.object);
    this.disposeObject(entry.object);
    this.models.delete(entry.id);
    this.selectedId = this.models.keys().next().value ?? null;
    if (this.selectedId) {
      this.transform.attach(this.models.get(this.selectedId)!.object);
    }
    this.sync();
  }

  autoArrange(): void {
    if (this.models.size === 1) {
      const only = this.models.values().next().value;
      if (only) {
        this.centerObject(only.object);
        this.sync();
      }
      return;
    }

    const margin = 8;
    let x = -PLATE.x / 2 + margin;
    let y = -PLATE.y / 2 + margin;
    let rowDepth = 0;

    for (const entry of this.models.values()) {
      const size = this.sizeOf(entry.object);
      if (x + size.x > PLATE.x / 2 - margin) {
        x = -PLATE.x / 2 + margin;
        y += rowDepth + margin;
        rowDepth = 0;
      }

      entry.object.position.x += x + size.x / 2 - this.boxOf(entry.object).getCenter(new THREE.Vector3()).x;
      entry.object.position.y += y + size.y / 2 - this.boxOf(entry.object).getCenter(new THREE.Vector3()).y;
      this.keepAbovePlate(entry.object);
      x += size.x + margin;
      rowDepth = Math.max(rowDepth, size.y);
    }

    const arrangedBox = new THREE.Box3();
    for (const entry of this.models.values()) {
      arrangedBox.union(this.boxOf(entry.object));
    }
    const arrangedCenter = arrangedBox.getCenter(new THREE.Vector3());
    for (const entry of this.models.values()) {
      entry.object.position.x -= arrangedCenter.x;
      entry.object.position.y -= arrangedCenter.y;
      this.keepAbovePlate(entry.object);
    }

    this.sync();
  }

  exportPlateAsStlBlob(): Blob {
    const exportRoot = new THREE.Group();
    const shiftToPrinterCoordinates = new THREE.Group();
    shiftToPrinterCoordinates.position.set(PLATE.x / 2, PLATE.y / 2, 0);

    for (const entry of this.models.values()) {
      const clone = entry.object.clone(true);
      shiftToPrinterCoordinates.add(clone);
    }

    exportRoot.add(shiftToPrinterCoordinates);
    exportRoot.updateMatrixWorld(true);
    const result = new STLExporter().parse(exportRoot, { binary: true });
    const buffer = typeof result === "string" ? new TextEncoder().encode(result).buffer : result;
    return new Blob([buffer], { type: "model/stl" });
  }

  private setupScene(): void {
    this.scene.background = new THREE.Color("#eef2f5");

    const hemi = new THREE.HemisphereLight("#ffffff", "#8f969d", 1.8);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight("#ffffff", 2.3);
    key.position.set(-150, -200, 260);
    key.castShadow = true;
    key.shadow.camera.left = -180;
    key.shadow.camera.right = 180;
    key.shadow.camera.top = 180;
    key.shadow.camera.bottom = -180;
    this.scene.add(key);

    const plateGeometry = new THREE.PlaneGeometry(PLATE.x, PLATE.y);
    const plateMaterial = new THREE.MeshStandardMaterial({
      color: "#d7dce1",
      roughness: 0.72,
      metalness: 0.08,
    });
    const plate = new THREE.Mesh(plateGeometry, plateMaterial);
    plate.receiveShadow = true;
    plate.position.set(0, 0, -0.02);
    this.scene.add(plate);

    this.scene.add(this.makeGrid());
    this.scene.add(this.makeBuildVolume());
    this.scene.add(this.makeAxisLabel("X", new THREE.Vector3(PLATE.x / 2 + 8, 0, 0), "#d94848"));
    this.scene.add(this.makeAxisLabel("Y", new THREE.Vector3(0, PLATE.y / 2 + 8, 0), "#198f78"));
    this.scene.add(this.makeAxisLabel("Z", new THREE.Vector3(0, 0, PLATE.z + 8), "#2563eb"));
  }

  private makeGrid(): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    const halfX = PLATE.x / 2;
    const halfY = PLATE.y / 2;
    const step = 10;

    for (let x = -halfX; x <= halfX; x += step) {
      vertices.push(x, -halfY, 0.01, x, halfY, 0.01);
    }
    for (let y = -halfY; y <= halfY; y += step) {
      vertices.push(-halfX, y, 0.01, halfX, y, 0.01);
    }

    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: "#9aa3ad",
        transparent: true,
        opacity: 0.35,
      }),
    );
  }

  private makeBuildVolume(): THREE.LineSegments {
    const halfX = PLATE.x / 2;
    const halfY = PLATE.y / 2;
    const z = PLATE.z;
    const vertices = [
      -halfX, -halfY, 0, halfX, -halfY, 0,
      halfX, -halfY, 0, halfX, halfY, 0,
      halfX, halfY, 0, -halfX, halfY, 0,
      -halfX, halfY, 0, -halfX, -halfY, 0,
      -halfX, -halfY, z, halfX, -halfY, z,
      halfX, -halfY, z, halfX, halfY, z,
      halfX, halfY, z, -halfX, halfY, z,
      -halfX, halfY, z, -halfX, -halfY, z,
      -halfX, -halfY, 0, -halfX, -halfY, z,
      halfX, -halfY, 0, halfX, -halfY, z,
      halfX, halfY, 0, halfX, halfY, z,
      -halfX, halfY, 0, -halfX, halfY, z,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: "#334155",
        transparent: true,
        opacity: 0.42,
      }),
    );
  }

  private makeAxisLabel(text: string, position: THREE.Vector3, color: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.font = "700 54px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 48, 48);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.position.copy(position);
    sprite.scale.set(16, 16, 16);
    return sprite;
  }

  private createMaterial(index: number): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: COLORS[index % COLORS.length],
      roughness: 0.55,
      metalness: 0.04,
    });
  }

  private prepareMaterials(object: THREE.Object3D, index: number): void {
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = this.createMaterial(index);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.geometry.computeVertexNormals();
      }
    });
  }

  private normalizeObject(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.y -= center.y;
    object.position.z -= box.min.z;
    object.updateMatrixWorld(true);
  }

  private centerObject(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.y -= center.y;
    this.keepAbovePlate(object);
  }

  private keepAbovePlate(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.min.z < 0) {
      object.position.z -= box.min.z;
    }
  }

  private selectedEntry(): ModelEntry | null {
    return this.selectedId ? this.models.get(this.selectedId) ?? null : null;
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.resize);
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.onError("The 3D preview ran out of graphics memory. Reload the page and use a smaller or simplified model.");
  };

  private handleContextRestored = (): void => {
    this.onError(null);
    this.resize();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.downPoint = { x: event.clientX, y: event.clientY };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.downPoint || this.transform.dragging) return;
    const dx = event.clientX - this.downPoint.x;
    const dy = event.clientY - this.downPoint.y;
    this.downPoint = null;
    if (Math.hypot(dx, dy) > 4) return;

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = [...this.models.values()].map((entry) => entry.object);
    const hit = this.raycaster.intersectObjects(objects, true)[0];
    this.selectModel(hit?.object.userData.modelId ?? null);
  };

  private resize = (): void => {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const width = Math.max(1, rect?.width ?? this.canvas.clientWidth);
    const height = Math.max(1, rect?.height ?? this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private animate = (): void => {
    this.frame = requestAnimationFrame(this.animate);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  private boxOf(object: THREE.Object3D): THREE.Box3 {
    object.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(object);
  }

  private sizeOf(object: THREE.Object3D): THREE.Vector3 {
    return this.boxOf(object).getSize(new THREE.Vector3());
  }

  private validateModel(object: THREE.Object3D, filename: string): void {
    let meshCount = 0;
    let vertexCount = 0;

    object.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const position = mesh.geometry.getAttribute("position");
      if (!position || position.count < 3) return;
      meshCount += 1;
      vertexCount += position.count;
    });

    if (meshCount === 0 || vertexCount < 3) {
      throw new Error(`${filename} does not contain readable mesh geometry.`);
    }
    if (vertexCount > MAX_PREVIEW_VERTICES) {
      throw new Error(
        `${filename} contains ${vertexCount.toLocaleString()} vertices. Simplify it below ${MAX_PREVIEW_VERTICES.toLocaleString()} vertices for a stable browser preview.`,
      );
    }

    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const values = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
    const size = box.getSize(new THREE.Vector3());
    if (box.isEmpty() || values.some((value) => !Number.isFinite(value)) || size.lengthSq() <= 0) {
      throw new Error(`${filename} has invalid or zero-size geometry.`);
    }
  }

  private focusObject(object: THREE.Object3D): void {
    const box = this.boxOf(object);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    if (sphere.isEmpty() || !Number.isFinite(sphere.radius)) return;

    const radius = Math.max(sphere.radius, 55);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = (radius / Math.sin(halfFov)) * 1.2;
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    const target = sphere.center.clone();

    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(direction.multiplyScalar(distance));
    this.camera.near = Math.max(0.05, distance / 5000);
    this.camera.far = Math.max(2000, distance * 10);
    this.camera.updateProjectionMatrix();
    this.orbit.minDistance = Math.max(1, radius * 0.08);
    this.orbit.maxDistance = Math.max(2000, distance * 8);
    this.orbit.update();
  }

  private snapshotFor(entry: ModelEntry): ModelSnapshot {
    const box = this.boxOf(entry.object);
    const size = box.getSize(new THREE.Vector3());
    const warnings: string[] = [];
    const eps = 0.05;
    let triangleCount = 0;

    entry.object.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const geometry = (child as THREE.Mesh).geometry;
      const elementCount = geometry.getIndex()?.count ?? geometry.getAttribute("position")?.count ?? 0;
      triangleCount += Math.floor(elementCount / 3);
    });

    if (box.min.x < -PLATE.x / 2 - eps || box.max.x > PLATE.x / 2 + eps) {
      warnings.push("Outside X boundary");
    }
    if (box.min.y < -PLATE.y / 2 - eps || box.max.y > PLATE.y / 2 + eps) {
      warnings.push("Outside Y boundary");
    }
    if (box.max.z > PLATE.z + eps) {
      warnings.push("Exceeds K2 SE height");
    }
    if (box.min.z > 0.2) {
      warnings.push("Floating above plate");
    }
    if (box.min.z < -eps) {
      warnings.push("Below plate");
    }
    if (triangleCount >= 500_000) {
      warnings.push(`High mesh detail: ${triangleCount.toLocaleString()} triangles; browser slicing may take several minutes`);
    }

    const selected = entry.id === this.selectedId;
    const valid = !warnings.some((warning) => warning.includes("Outside") || warning.includes("Exceeds") || warning.includes("Below"));
    this.tintObject(entry, selected, valid);

    return {
      id: entry.id,
      name: entry.name,
      color: `#${entry.color.getHexString()}`,
      selected,
      triangleCount,
      dimensions: {
        x: Number(size.x.toFixed(2)),
        y: Number(size.y.toFixed(2)),
        z: Number(size.z.toFixed(2)),
      },
      position: {
        x: Number(entry.object.position.x.toFixed(2)),
        y: Number(entry.object.position.y.toFixed(2)),
        z: Number(entry.object.position.z.toFixed(2)),
      },
      rotation: {
        x: Number((entry.object.rotation.x * DEG).toFixed(1)),
        y: Number((entry.object.rotation.y * DEG).toFixed(1)),
        z: Number((entry.object.rotation.z * DEG).toFixed(1)),
      },
      scale: {
        x: Number(entry.object.scale.x.toFixed(3)),
        y: Number(entry.object.scale.y.toFixed(3)),
        z: Number(entry.object.scale.z.toFixed(3)),
      },
      valid,
      warnings,
    };
  }

  private tintObject(entry: ModelEntry, selected: boolean, valid: boolean): void {
    const color = valid ? entry.color : new THREE.Color("#dc2626");
    entry.object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial) {
            material.color.copy(color);
            material.emissive.set(selected ? "#153b52" : "#000000");
            material.emissiveIntensity = selected ? 0.18 : 0;
          }
        }
      }
    });
  }

  private sync(): void {
    this.onChange([...this.models.values()].map((entry) => this.snapshotFor(entry)), this.selectedId);
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.dispose();
      }
    });
  }
}
