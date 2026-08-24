import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { FontLoader, type FontData } from "three/examples/jsm/loaders/FontLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import helvetikerBold from "three/examples/fonts/helvetiker_bold.typeface.json";
import { strToU8, zipSync } from "fflate";
import { K2_SE_PROFILE } from "../../shared/profile";

export type TransformMode = "translate" | "rotate" | "scale";
export type CadPrimitiveKind = "box" | "cylinder" | "sphere" | "cone" | "tube" | "basketball" | "airlessBall" | "text";
export type CameraView = "iso" | "top" | "front" | "right";
export type ModelFileFormat = "stl" | "3mf";

export interface CadDefinition {
  kind: CadPrimitiveKind;
  width: number;
  depth: number;
  height: number;
  diameter: number;
  topDiameter: number;
  innerDiameter: number;
  text?: string;
  fontSize?: number;
}

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
  cad: CadDefinition | null;
  connected: boolean;
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
  cad?: CadDefinition;
  connected?: boolean;
  sourceParts?: SourcePart[];
}

interface SourcePart {
  name: string;
  object: THREE.Object3D;
  color: THREE.Color;
  cad?: CadDefinition;
  connected?: boolean;
  sourceParts?: SourcePart[];
}

const PLATE = K2_SE_PROFILE.buildVolume;
const COLORS = ["#f97316", "#14b8a6", "#ef4444", "#3b82f6", "#eab308", "#a855f7", "#22c55e"];
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const MAX_MODEL_FILE_BYTES = 150 * 1024 * 1024;
const MAX_PREVIEW_VERTICES = 4_000_000;
const CAD_FONT = new FontLoader().parse(helvetikerBold as FontData);

function format3mfNumber(value: number): string {
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value;
  return Number(normalized.toFixed(6)).toString();
}

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

  async loadGeneratedGlb(buffer: ArrayBuffer, name: string): Promise<string> {
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    const object = gltf.scene;
    this.validateModel(object, name);
    this.prepareMaterials(object, this.models.size);
    object.updateMatrixWorld(true);
    const initialSize = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    const largest = Math.max(initialSize.x, initialSize.y, initialSize.z);
    if (!Number.isFinite(largest) || largest <= 0) throw new Error("The generated mesh has invalid dimensions.");
    object.scale.multiplyScalar(90 / largest);
    this.normalizeObject(object);

    const id = crypto.randomUUID();
    const color = new THREE.Color(COLORS[this.models.size % COLORS.length]);
    object.userData.modelId = id;
    object.traverse(child => { child.userData.modelId = id; });
    this.models.set(id, { id, name, object, color });
    this.scene.add(object);
    this.centerObject(object);
    this.selectModel(id);
    this.focusObject(object);
    this.sync();
    return id;
  }

  createCadPrimitive(definition: CadDefinition): string {
    const cad = this.normalizeCadDefinition(definition);
    const id = crypto.randomUUID();
    const color = new THREE.Color(COLORS[this.models.size % COLORS.length]);
    const geometry = this.createCadGeometry(cad);
    const object = new THREE.Mesh(geometry, this.createMaterial(this.models.size));
    object.castShadow = true;
    object.receiveShadow = true;
    object.userData.modelId = id;

    const kindCount = [...this.models.values()].filter((entry) => entry.cad?.kind === cad.kind).length + 1;
    const name = `CAD ${cad.kind[0].toUpperCase()}${cad.kind.slice(1)} ${kindCount}`;
    this.models.set(id, { id, name, object, color, cad });
    this.scene.add(object);
    this.centerObject(object);
    this.selectModel(id);
    this.focusObject(object);
    this.sync();
    return id;
  }

  updateSelectedCadPrimitive(definition: CadDefinition): void {
    const entry = this.selectedEntry();
    if (!entry?.cad || !(entry.object instanceof THREE.Mesh)) return;

    const cad = this.normalizeCadDefinition(definition);
    const oldGeometry = entry.object.geometry;
    entry.object.geometry = this.createCadGeometry(cad);
    entry.cad = cad;
    oldGeometry.dispose();
    this.keepAbovePlate(entry.object);
    this.sync();
  }

  setMode(mode: TransformMode): void {
    this.transform.setMode(mode);
  }

  setCameraView(view: CameraView): void {
    const bounds = new THREE.Box3();
    for (const entry of this.models.values()) bounds.union(this.boxOf(entry.object));
    const target = bounds.isEmpty()
      ? new THREE.Vector3(0, 0, 35)
      : bounds.getCenter(new THREE.Vector3());
    const sphere = bounds.isEmpty() ? new THREE.Sphere(target, 90) : bounds.getBoundingSphere(new THREE.Sphere());
    const distance = Math.max(260, sphere.radius * 3.2);
    const directions: Record<CameraView, THREE.Vector3> = {
      iso: new THREE.Vector3(1, -1, 0.8),
      top: new THREE.Vector3(0, 0, 1),
      front: new THREE.Vector3(0, -1, 0.12),
      right: new THREE.Vector3(1, 0, 0.12),
    };

    this.camera.up.set(0, view === "top" ? 1 : 0, view === "top" ? 0 : 1);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(directions[view].normalize().multiplyScalar(distance));
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
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
        mesh.geometry = mesh.geometry.clone();
        mesh.material = this.createMaterial(this.models.size);
      }
    });

    this.models.set(id, {
      id,
      name: entry.cad ? `${entry.name} copy` : `${entry.name.replace(/\.(stl|3mf)$/i, "")} copy.stl`,
      object,
      color,
      cad: entry.cad ? { ...entry.cad } : undefined,
      connected: entry.connected,
      sourceParts: entry.sourceParts?.map((part) => this.cloneSourcePart(part)),
    });
    this.scene.add(object);
    this.selectModel(id);
    this.sync();
  }

  connectTouchingModels(): number {
    const selected = this.selectedEntry();
    if (!selected || this.models.size < 2) {
      this.onError("Select one of at least two overlapping objects to connect.");
      return 0;
    }

    const connected = new Set<ModelEntry>([selected]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of this.models.values()) {
        if (connected.has(candidate)) continue;
        if ([...connected].some((entry) => this.objectsTouch(entry.object, candidate.object))) {
          connected.add(candidate);
          changed = true;
        }
      }
    }

    if (connected.size < 2) {
      this.onError("No touching object found. Move the parts so they overlap slightly, then connect them.");
      return 0;
    }

    this.connectEntries(connected);
    return connected.size;
  }

  connectModels(ids: Iterable<string>): string | null {
    const entries = [...ids].map(id => this.models.get(id)).filter((entry): entry is ModelEntry => Boolean(entry));
    if (entries.length < 2) return entries[0]?.id ?? null;
    const allowed = new Set(entries);
    const connected = new Set<ModelEntry>([entries[0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of allowed) {
        if (connected.has(candidate)) continue;
        if ([...connected].some(entry => this.objectsTouch(entry.object, candidate.object))) {
          connected.add(candidate);
          changed = true;
        }
      }
    }
    if (connected.size !== entries.length) return null;
    return this.connectEntries(connected);
  }

  private connectEntries(connected: Set<ModelEntry>): string {

    this.transform.detach();
    const id = crypto.randomUUID();
    const object = new THREE.Group();
    const color = connected.values().next().value!.color.clone();

    for (const entry of connected) {
      entry.object.updateMatrixWorld(true);
      entry.object.traverse((child) => {
        const sourceMesh = child as THREE.Mesh;
        if (!sourceMesh.isMesh) return;
        const geometry = sourceMesh.geometry.clone();
        geometry.applyMatrix4(sourceMesh.matrixWorld);
        const mesh = new THREE.Mesh(geometry, this.createMaterial(this.models.size));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.modelId = id;
        object.add(mesh);
      });
    }

    const worldBox = new THREE.Box3().setFromObject(object);
    const origin = worldBox.getCenter(new THREE.Vector3());
    origin.z = worldBox.min.z;
    for (const child of object.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.translate(-origin.x, -origin.y, -origin.z);
    }
    object.position.copy(origin);
    object.userData.modelId = id;

    const sourceParts = [...connected].map((entry): SourcePart => {
      const source = this.cloneObject(entry.object);
      source.matrix.copy(entry.object.matrixWorld);
      source.matrix.decompose(source.position, source.quaternion, source.scale);
      source.position.sub(origin);
      source.updateMatrixWorld(true);
      return {
        name: entry.name,
        object: source,
        color: entry.color.clone(),
        cad: entry.cad ? { ...entry.cad } : undefined,
        connected: entry.connected,
        sourceParts: entry.sourceParts?.map((part) => this.cloneSourcePart(part)),
      };
    });

    for (const entry of connected) {
      this.scene.remove(entry.object);
      this.disposeObject(entry.object);
      this.models.delete(entry.id);
    }

    const connectedCount = [...this.models.values()].filter((entry) => entry.connected).length + 1;
    this.models.set(id, {
      id,
      name: `Connected Part ${connectedCount}`,
      object,
      color,
      connected: true,
      sourceParts,
    });
    this.scene.add(object);
    this.selectedId = id;
    this.transform.attach(object);
    this.onError(null);
    this.sync();
    return id;
  }

  disassembleSelected(): string[] {
    const entry = this.selectedEntry();
    if (!entry?.connected || !entry.sourceParts?.length) {
      this.onError("Select a connected CAD assembly to disassemble.");
      return [];
    }

    this.transform.detach();
    entry.object.updateMatrixWorld(true);
    const restoredIds: string[] = [];
    const restoredEntries: ModelEntry[] = [];

    for (const part of entry.sourceParts) {
      const id = crypto.randomUUID();
      const object = this.cloneObject(part.object);
      object.updateMatrix();
      object.applyMatrix4(entry.object.matrixWorld);
      object.userData.modelId = id;
      object.traverse((child) => {
        child.userData.modelId = id;
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.material = this.createMaterial(this.models.size + restoredEntries.length);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      restoredIds.push(id);
      restoredEntries.push({
        id,
        name: part.name,
        object,
        color: part.color.clone(),
        cad: part.cad ? { ...part.cad } : undefined,
        connected: part.connected,
        sourceParts: part.sourceParts?.map((source) => this.cloneSourcePart(source)),
      });
    }

    this.scene.remove(entry.object);
    this.disposeObject(entry.object);
    this.models.delete(entry.id);
    for (const restored of restoredEntries) {
      this.models.set(restored.id, restored);
      this.scene.add(restored.object);
    }
    this.selectedId = restoredIds[0] ?? null;
    if (this.selectedId) this.transform.attach(this.models.get(this.selectedId)!.object);
    this.onError(null);
    this.sync();
    return restoredIds;
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

  deleteModels(ids: Iterable<string>): void {
    const removed = new Set(ids);
    let changed = false;
    for (const id of removed) {
      const entry = this.models.get(id);
      if (!entry) continue;
      if (this.selectedId === id) this.transform.detach();
      this.scene.remove(entry.object);
      this.disposeObject(entry.object);
      this.models.delete(id);
      changed = true;
    }
    if (!changed) return;
    if (this.selectedId && !this.models.has(this.selectedId)) {
      this.selectedId = this.models.keys().next().value ?? null;
    }
    if (this.selectedId) this.transform.attach(this.models.get(this.selectedId)!.object);
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

  exportSelectedAsStlBlob(): Blob | null {
    const entry = this.selectedEntry();
    if (!entry) return null;

    const clone = entry.object.clone(true);
    clone.position.set(0, 0, 0);
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    clone.position.x -= center.x;
    clone.position.y -= center.y;
    clone.position.z -= box.min.z;
    clone.updateMatrixWorld(true);
    const result = new STLExporter().parse(clone, { binary: true });
    const buffer = typeof result === "string" ? new TextEncoder().encode(result).buffer : result;
    return new Blob([buffer], { type: "model/stl" });
  }

  exportSelectedAs3mfBlob(): Blob | null {
    const entry = this.selectedEntry();
    if (!entry) return null;

    const clone = entry.object.clone(true);
    clone.position.set(0, 0, 0);
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    clone.position.x -= center.x;
    clone.position.y -= center.y;
    clone.position.z -= box.min.z;
    clone.updateMatrixWorld(true);
    return this.objectTo3mfBlob(clone);
  }

  async convertFile(file: File, output: ModelFileFormat): Promise<Blob> {
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_MODEL_FILE_BYTES) {
      throw new Error(`${file.name} is larger than the 150 MB browser conversion limit.`);
    }

    const extension = file.name.toLowerCase().split(".").pop();
    const buffer = await file.arrayBuffer();
    let object: THREE.Object3D;

    if (extension === "stl") {
      object = new THREE.Mesh(new STLLoader().parse(buffer));
    } else if (extension === "3mf") {
      object = new ThreeMFLoader().parse(buffer);
    } else {
      throw new Error("Choose an STL or 3MF file to convert.");
    }

    this.validateModel(object, file.name);
    object.updateMatrixWorld(true);
    if (output === "3mf") return this.objectTo3mfBlob(object);

    const result = new STLExporter().parse(object, { binary: true });
    const outputBuffer = typeof result === "string" ? new TextEncoder().encode(result).buffer : result;
    return new Blob([outputBuffer], { type: "model/stl" });
  }

  private objectTo3mfBlob(object: THREE.Object3D): Blob {
    const vertices: string[] = [];
    const triangles: string[] = [];
    const vertex = new THREE.Vector3();
    let vertexOffset = 0;

    object.updateMatrixWorld(true);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      const positions = geometry.getAttribute("position");
      if (!positions) return;

      for (let index = 0; index < positions.count; index += 1) {
        vertex.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
        vertices.push(`<vertex x="${format3mfNumber(vertex.x)}" y="${format3mfNumber(vertex.y)}" z="${format3mfNumber(vertex.z)}"/>`);
      }

      if (geometry.index) {
        for (let index = 0; index < geometry.index.count; index += 3) {
          triangles.push(`<triangle v1="${vertexOffset + geometry.index.getX(index)}" v2="${vertexOffset + geometry.index.getX(index + 1)}" v3="${vertexOffset + geometry.index.getX(index + 2)}"/>`);
        }
      } else {
        for (let index = 0; index + 2 < positions.count; index += 3) {
          triangles.push(`<triangle v1="${vertexOffset + index}" v2="${vertexOffset + index + 1}" v3="${vertexOffset + index + 2}"/>`);
        }
      }
      vertexOffset += positions.count;
    });

    if (triangles.length === 0) throw new Error("The model has no printable triangles to export.");
    const modelXml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
    const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
    const archive = zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "3D/3dmodel.model": strToU8(modelXml),
    }, { level: 6 });
    return new Blob([Uint8Array.from(archive).buffer], { type: "model/3mf" });
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

  private normalizeCadDefinition(definition: CadDefinition): CadDefinition {
    const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
    const diameter = Math.max(0.5, finite(definition.diameter, 30));
    return {
      kind: definition.kind,
      width: Math.max(0.5, finite(definition.width, 30)),
      depth: Math.max(0.5, finite(definition.depth, 30)),
      height: Math.max(0.5, finite(definition.height, 20)),
      diameter,
      topDiameter: Math.max(0, finite(definition.topDiameter, 0)),
      innerDiameter: Math.max(0.25, Math.min(diameter - 0.25, finite(definition.innerDiameter, diameter / 2))),
      text: definition.text?.replace(/[^\x20-\x7e]/g, "").slice(0, 24) || "TEXT",
      fontSize: Math.max(3, Math.min(40, finite(definition.fontSize ?? 12, 12))),
    };
  }

  private createCadGeometry(definition: CadDefinition): THREE.BufferGeometry {
    let geometry: THREE.BufferGeometry;
    const radius = definition.diameter / 2;

    switch (definition.kind) {
      case "box":
        geometry = new THREE.BoxGeometry(definition.width, definition.depth, definition.height);
        break;
      case "cylinder":
        geometry = new THREE.CylinderGeometry(radius, radius, definition.height, 64);
        geometry.rotateX(Math.PI / 2);
        break;
      case "sphere":
        geometry = new THREE.SphereGeometry(radius, 64, 32);
        break;
      case "basketball": {
        const ball = new THREE.SphereGeometry(radius, 64, 32);
        const seamRadius = radius * 0.985;
        const seamThickness = Math.max(0.35, radius * 0.025);
        const seamXY = new THREE.TorusGeometry(seamRadius, seamThickness, 10, 96);
        const seamXZ = seamXY.clone().rotateX(Math.PI / 2);
        const seamYZ = seamXY.clone().rotateY(Math.PI / 2);
        geometry = mergeGeometries([ball, seamXY, seamXZ, seamYZ], false) ?? ball;
        break;
      }
      case "airlessBall": {
        const cage = new THREE.IcosahedronGeometry(radius * 0.96, 1);
        const edges = new THREE.EdgesGeometry(cage, 1);
        const positions = edges.getAttribute("position");
        const struts: THREE.BufferGeometry[] = [];
        const start = new THREE.Vector3();
        const end = new THREE.Vector3();
        const midpoint = new THREE.Vector3();
        const direction = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        for (let index = 0; index < positions.count; index += 2) {
          start.fromBufferAttribute(positions, index);
          end.fromBufferAttribute(positions, index + 1);
          direction.subVectors(end, start);
          const length = direction.length();
          midpoint.addVectors(start, end).multiplyScalar(0.5);
          const strut = new THREE.CylinderGeometry(Math.max(0.55, radius * 0.045), Math.max(0.55, radius * 0.045), length, 8);
          strut.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
          strut.translate(midpoint.x, midpoint.y, midpoint.z);
          struts.push(strut);
        }
        geometry = mergeGeometries(struts, false) ?? cage;
        edges.dispose();
        cage.dispose();
        break;
      }
      case "text":
        geometry = new TextGeometry(definition.text ?? "TEXT", {
          font: CAD_FONT,
          size: definition.fontSize ?? 12,
          depth: definition.height,
          curveSegments: 8,
          bevelEnabled: true,
          bevelThickness: 0.18,
          bevelSize: 0.12,
          bevelSegments: 2,
        });
        break;
      case "cone":
        geometry = new THREE.CylinderGeometry(definition.topDiameter / 2, radius, definition.height, 64);
        geometry.rotateX(Math.PI / 2);
        break;
      case "tube": {
        const shape = new THREE.Shape();
        shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
        const hole = new THREE.Path();
        hole.absarc(0, 0, definition.innerDiameter / 2, 0, Math.PI * 2, true);
        shape.holes.push(hole);
        geometry = new THREE.ExtrudeGeometry(shape, {
          depth: definition.height,
          bevelEnabled: false,
          curveSegments: 64,
          steps: 1,
        });
        break;
      }
    }

    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -box.min.z);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
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
      cad: entry.cad ? { ...entry.cad } : null,
      connected: Boolean(entry.connected),
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

  private objectsTouch(a: THREE.Object3D, b: THREE.Object3D): boolean {
    const first = this.boxOf(a);
    const second = this.boxOf(b);
    const tolerance = 0.05;
    return (
      Math.min(first.max.x, second.max.x) - Math.max(first.min.x, second.min.x) >= -tolerance &&
      Math.min(first.max.y, second.max.y) - Math.max(first.min.y, second.min.y) >= -tolerance &&
      Math.min(first.max.z, second.max.z) - Math.max(first.min.z, second.min.z) >= -tolerance
    );
  }

  private sync(): void {
    this.onChange([...this.models.values()].map((entry) => this.snapshotFor(entry)), this.selectedId);
  }

  private cloneObject(source: THREE.Object3D): THREE.Object3D {
    const clone = source.clone(true);
    clone.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      mesh.geometry = mesh.geometry.clone();
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
    });
    return clone;
  }

  private cloneSourcePart(part: SourcePart): SourcePart {
    return {
      name: part.name,
      object: this.cloneObject(part.object),
      color: part.color.clone(),
      cad: part.cad ? { ...part.cad } : undefined,
      connected: part.connected,
      sourceParts: part.sourceParts?.map((source) => this.cloneSourcePart(source)),
    };
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
