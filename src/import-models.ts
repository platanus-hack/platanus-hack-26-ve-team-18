import { BufferAttribute, Mesh, type BufferGeometry, type Material } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { ModelPart, Vec3 } from './models.ts';
import { decodeTextureEvidence, MAX_TEXTURE_BYTES, tissueScoresFromColors, type TextureEvidence } from './texture-evidence.ts';

// Workspace totals, shared by import validation and the application's existing parts.
export const MAX_WORKSPACE_PARTS = 64;
export const MAX_WORKSPACE_TRIANGLES = 2_000_000;
// Raw input budget for one import batch; geometry is never simplified to fit.
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const decoder = new TextDecoder();
type ImportResult = { parts: ModelPart[]; warnings: string[] };
type ParsedImport = ImportResult & { bindings: Map<string, string[]>; libraries: string[]; imageReferences: string[] };

/** File references are resolved only against this batch, never against a URL. */
function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() ?? '';
}

function remoteReference(path: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:\/\/|data:|blob:|\/\/)/i.test(path);
}

function stem(path: string): string { return basename(path).replace(/\.[^.]+$/, ''); }

function words(text: string): string[] {
  return Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), match => match[1] ?? match[2] ?? match[3]);
}

function extension(fileName: string): string {
  const value = fileName.split('.').pop()?.toLowerCase();
  if (value !== 'stl' && value !== 'obj' && value !== 'ply') {
    throw new Error(`${fileName}: unsupported format. Choose STL, OBJ, or PLY files.`);
  }
  return value;
}

function checkTriangles(count: number, limit: number): void {
  if (count > limit) throw new Error(`Import exceeds the ${MAX_WORKSPACE_TRIANGLES.toLocaleString('en-US')} triangle limit.`);
}

// Validate before the permissive loaders can discard faces or allocate from corrupt counts.
function validateOBJ(text: string, limit: number): { triangles: number; uvFaces: boolean[] } {
  let vertices = 0;
  let textureVertices = 0;
  let triangles = 0;
  const uvFaces: boolean[] = [];
  for (const match of text.matchAll(/^[\t ]*(vt|v|f)(?:[\t ]+([^\r\n]*))?[\t ]*\r?$/gm)) {
    const fields = (match[2] ?? '').trim().split(/\s+/);
    if (match[1] === 'vt') {
      if (fields.length < 2 || fields.slice(0, 2).some(value => !Number.isFinite(Math.fround(Number(value))))) throw new Error('OBJ texture vertex contains missing or non-finite UV coordinates.');
      textureVertices++;
    } else if (match[1] === 'v') {
      if (fields.length < 3 || fields.slice(0, 3).some(value => !Number.isFinite(Math.fround(Number(value))))) {
        throw new Error('OBJ vertex contains missing or non-finite xyz coordinates.');
      }
      vertices++;
    } else {
      if (fields.length < 3) throw new Error('OBJ face needs at least three vertices.');
      for (const field of fields) {
        const index = Number(field.split('/')[0]);
        if (!Number.isInteger(index) || index === 0 || index > vertices || index < -vertices) {
          throw new Error('OBJ face references an invalid vertex index.');
        }
        const uv = field.split('/')[1];
        if (uv && (!Number.isInteger(Number(uv)) || Number(uv) === 0 || Number(uv) > textureVertices || Number(uv) < -textureVertices)) throw new Error('OBJ face references an invalid texture vertex index.');
      }
      triangles += fields.length - 2;
      checkTriangles(triangles, limit);
      for (let index = 1; index < fields.length - 1; index++) uvFaces.push([fields[0], fields[index], fields[index + 1]].every(field => !!field.split('/')[1]));
    }
  }
  if (!triangles) throw new Error('No triangle surface found; point clouds and lines are not supported.');
  return { triangles, uvFaces };
}

function validateSTL(buffer: ArrayBuffer, limit: number): number {
  const bytes = new Uint8Array(buffer);
  const count = buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0;
  const binaryLength = 84 + count * 50;
  // Match STLLoader's binary/ASCII detection, including BOM prefixes.
  const ascii = [0, 1, 2, 3, 4].some(offset => [115, 111, 108, 105, 100].every((byte, index) => bytes[offset + index] === byte));
  if (binaryLength === buffer.byteLength || !ascii) {
    checkTriangles(count, limit);
    if (binaryLength !== buffer.byteLength) throw new Error('Binary STL is truncated or has an invalid triangle count.');
    if (!count) throw new Error('STL contains no triangle surface.');
    return count;
  }
  const text = decoder.decode(buffer);
  let faces = 0;
  for (const face of text.matchAll(/\bfacet\b([\s\S]*?)\bendfacet\b/g)) {
    let vertices = 0;
    for (const vertex of face[1].matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
      if (vertex.slice(1).some(value => !Number.isFinite(Math.fround(Number(value))))) {
        throw new Error('STL vertex contains non-finite xyz coordinates.');
      }
      vertices++;
    }
    if (vertices !== 3) throw new Error('Each STL facet must contain exactly three valid vertices.');
    checkTriangles(++faces, limit);
  }
  if (!faces || faces !== (text.match(/\bfacet\b/g)?.length ?? 0)) {
    throw new Error('STL contains no complete triangle surface or has an incomplete facet.');
  }
  return faces;
}

type PlyProperty = { name: string; type: string; countType?: string };
type PlyElement = { name: string; count: number; properties: PlyProperty[] };
type PlyGetter = 'getInt8' | 'getUint8' | 'getInt16' | 'getUint16' | 'getInt32' | 'getUint32' | 'getFloat32' | 'getFloat64';
const plyTypes: Record<string, [number, PlyGetter]> = {
  char: [1, 'getInt8'], int8: [1, 'getInt8'], uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
  short: [2, 'getInt16'], int16: [2, 'getInt16'], ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
  int: [4, 'getInt32'], int32: [4, 'getInt32'], uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
  float: [4, 'getFloat32'], float32: [4, 'getFloat32'], double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};

function validatePLY(buffer: ArrayBuffer, limit: number): { triangles: number; imageReferences: string[]; hasFaceUVs: boolean; faceUVs?: Float32Array } {
  const bytes = new Uint8Array(buffer);
  const elements: PlyElement[] = [];
  const imageReferences: string[] = [];
  let cursor = 0;
  let format = '';
  while (cursor < bytes.length) {
    const end = bytes.indexOf(10, cursor);
    if (end < 0) throw new Error('PLY has an incomplete header.');
    const line = decoder.decode(bytes.subarray(cursor, end)).trim();
    if (cursor === 0 && line !== 'ply') throw new Error('Invalid PLY header.');
    cursor = end + 1;
    const fields = line.split(/\s+/);
    const textureComment = /^comment\s+TextureFile\s+(.+)$/i.exec(line);
    if (textureComment) imageReferences.push(words(textureComment[1]).join(' '));
    if (fields[0] === 'format') format = fields[1];
    if (fields[0] === 'element') {
      const count = Number(fields[2]);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length) throw new Error('Invalid PLY element count.');
      elements.push({ name: fields[1], count, properties: [] });
    }
    if (fields[0] === 'property') {
      const element = elements.at(-1);
      if (!element) throw new Error('PLY property has no element.');
      const list = fields[1] === 'list';
      const type = fields[list ? 3 : 1];
      if (!plyTypes[type] || (list && !plyTypes[fields[2]])) throw new Error('Unsupported PLY property type.');
      element.properties.push({ name: fields[list ? 4 : 2], type, countType: list ? fields[2] : undefined });
    }
    if (line === 'end_header') break;
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) throw new Error('Unsupported PLY encoding.');
  const vertexCount = elements.find(element => element.name === 'vertex')?.count ?? 0;
  const faceCount = elements.find(element => element.name === 'face')?.count ?? 0;
  if (!vertexCount || !faceCount) throw new Error('PLY has no triangle surface; point clouds are not supported.');
  checkTriangles(faceCount, limit);
  const hasFaceUVs = elements.some(element => element.name === 'face' && element.properties.some(property => property.name === 'texcoord' && property.countType));
  let faceUVs = hasFaceUVs ? new Float32Array(faceCount * 6) : undefined;
  let uvCursor = 0, completeUVs = true;
  const tokens = format === 'ascii' ? decoder.decode(bytes.subarray(cursor)).matchAll(/\S+/g) : null;
  const view = new DataView(buffer);
  function read(type: string): number {
    if (tokens) {
      const token = tokens.next();
      if (token.done) throw new Error('PLY data is incomplete.');
      return Number(token.value[0]);
    }
    const [size, getter] = plyTypes[type];
    if (cursor + size > bytes.length) throw new Error('Binary PLY data is incomplete.');
    const value = view[getter](cursor, format === 'binary_little_endian');
    cursor += size;
    return value;
  }
  let triangles = 0;
  for (const element of elements) {
    const xyz = element.properties.filter(property => /^(x|y|z|px|py|pz|posx|posy|posz)$/.test(property.name));
    if (element.name === 'vertex' && xyz.length !== 3) throw new Error('PLY vertices need x, y, and z coordinates.');
    for (let row = 0; row < element.count; row++) {
      let hasFace = false;
      let faceCorners = 0;
      let faceUV: number[] | undefined;
      for (const property of element.properties) {
        if (!property.countType) {
          const value = read(property.type);
          if (element.name === 'vertex' && xyz.includes(property) && !Number.isFinite(Math.fround(value))) {
            throw new Error('PLY vertex contains non-finite xyz coordinates.');
          }
          continue;
        }
        const count = read(property.countType);
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length) throw new Error('Invalid PLY list length.');
        const face = element.name === 'face' && /^(vertex_indices|vertex_index)$/.test(property.name);
        if (face) {
          if (count !== 3 && count !== 4) throw new Error('PLY faces must be triangles or quads; triangulate larger polygons before importing.');
          hasFace = true;
          faceCorners = count;
          triangles += count - 2;
          checkTriangles(triangles, limit);
        }
        const textureCoordinates = element.name === 'face' && property.name === 'texcoord';
        if (textureCoordinates) faceUV = [];
        for (let item = 0; item < count; item++) {
          const value = read(property.type);
          if (textureCoordinates) faceUV!.push(value);
          if (face && (!Number.isInteger(value) || value < 0 || value >= vertexCount)) {
            throw new Error('PLY face references an invalid vertex index.');
          }
        }
      }
      if (element.name === 'face' && !hasFace) throw new Error('PLY face has no vertex indices.');
      if (element.name === 'face' && faceUVs) {
        if (faceUV?.length !== faceCorners * 2 || !faceUV.every(value => Number.isFinite(Math.fround(value)))) completeUVs = false;
        else {
          const cornerOrder = faceCorners === 3 ? [0, 1, 2] : [0, 1, 3, 1, 2, 3];
          if (uvCursor + cornerOrder.length * 2 > faceUVs.length) {
            const expanded = new Float32Array(Math.min(limit * 6, Math.max(faceUVs.length * 2, uvCursor + cornerOrder.length * 2)));
            expanded.set(faceUVs);
            faceUVs = expanded;
          }
          for (const corner of cornerOrder) {
            faceUVs[uvCursor++] = faceUV[corner * 2];
            faceUVs[uvCursor++] = faceUV[corner * 2 + 1];
          }
        }
      }
    }
  }
  return { triangles, imageReferences, hasFaceUVs, faceUVs: faceUVs && completeUVs ? faceUVs.subarray(0, uvCursor) : undefined };
}

function splitGeometry(geometry: BufferGeometry, name: string, fileName: string, partLimit: number, triangleLimit: number, source?: { uvFaces: boolean[]; faceMaterials: string[]; bindings: Map<string, string[]> }): ModelPart[] {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  const corners = index ? index.count : position?.count ?? 0;
  if (!position || position.itemSize !== 3 || !corners || corners % 3 !== 0) {
    throw new Error('No valid triangle surface found; point clouds are not supported.');
  }
  const triangleCount = corners / 3;
  checkTriangles(triangleCount, triangleLimit);
  const welded = new Map<string, number>();
  const vertexIds = new Uint32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = Math.fround(position.getX(vertex));
    const y = Math.fround(position.getY(vertex));
    const z = Math.fround(position.getZ(vertex));
    if (![x, y, z].every(Number.isFinite)) throw new Error('Geometry contains non-finite xyz coordinates.');
    // Exact Float32 coordinates preserve every gap representable by the output arrays.
    const key = `${x},${y},${z}`;
    let id = welded.get(key);
    if (id === undefined) { id = welded.size; welded.set(key, id); }
    vertexIds[vertex] = id;
  }
  const parents = Int32Array.from({ length: triangleCount }, (_, triangle) => triangle);
  const firstTriangle = new Int32Array(welded.size).fill(-1);
  const vertexAt = (corner: number) => index ? index.getX(corner) : corner;
  function root(triangle: number): number {
    while (parents[triangle] !== triangle) {
      parents[triangle] = parents[parents[triangle]];
      triangle = parents[triangle];
    }
    return triangle;
  }
  for (let corner = 0; corner < corners; corner++) {
    const vertex = vertexAt(corner);
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) throw new Error('Face references an invalid vertex index.');
    const id = vertexIds[vertex];
    const triangle = Math.floor(corner / 3);
    if (firstTriangle[id] === -1) firstTriangle[id] = triangle;
    else parents[root(triangle)] = root(firstTriangle[id]);
  }
  const components = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const key = root(triangle);
    let component = components.get(key);
    if (!component) {
      if (components.size >= partLimit) throw new Error(`Import exceeds the ${MAX_WORKSPACE_PARTS} part limit; reduce disconnected components or import fewer files.`);
      component = [];
      components.set(key, component);
    }
    component.push(triangle);
  }
  const parts: ModelPart[] = [];
  for (const component of components.values()) {
    const positions = new Float32Array(component.length * 9);
    const normals = new Float32Array(positions.length);
    // Only complete source attributes can be mapped. Loader placeholders are not UV evidence.
    const uvs = uv?.itemSize === 2 && uv.count === position.count && (!source || component.every(triangle => source.uvFaces[triangle])) ? new Float32Array(component.length * 6) : undefined;
    const colors = color?.itemSize === 3 && color.count === position.count ? new Float32Array(positions.length) : undefined;
    const vertices = new Map<number, number>();
    const edges = new Map<number, number>();
    const fans = Int32Array.from({ length: component.length * 3 }, (_, corner) => corner);
    const idAt = (corner: number) => vertexIds[vertexAt(component[Math.floor(corner / 3)] * 3 + corner % 3)];
    function fanRoot(corner: number): number {
      while (fans[corner] !== corner) {
        fans[corner] = fans[fans[corner]];
        corner = fans[corner];
      }
      return corner;
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let cursor = 0;
    for (const triangle of component) {
      const ids: number[] = [];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = vertexAt(triangle * 3 + corner);
        ids.push(vertexIds[vertex]);
        if (!vertices.has(vertexIds[vertex])) vertices.set(vertexIds[vertex], cursor / 3 + corner);
        const values = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
        if (uvs) uvs.set([uv.getX(vertex), uv.getY(vertex)], cursor / 3 * 2 + corner * 2);
        if (colors) colors.set([color.getX(vertex), color.getY(vertex), color.getZ(vertex)], cursor + corner * 3);
        for (let axis = 0; axis < 3; axis++) {
          const value = Math.fround(values[axis]);
          positions[cursor + corner * 3 + axis] = value;
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
      const ux = positions[cursor + 3] - positions[cursor];
      const uy = positions[cursor + 4] - positions[cursor + 1];
      const uz = positions[cursor + 5] - positions[cursor + 2];
      const vx = positions[cursor + 6] - positions[cursor];
      const vy = positions[cursor + 7] - positions[cursor + 1];
      const vz = positions[cursor + 8] - positions[cursor + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (!length || !Number.isFinite(length)) throw new Error('Degenerate triangle has zero area or loses precision in Float32 coordinates.');
      for (let corner = 0; corner < 3; corner++) {
        normals.set([nx / length, ny / length, nz / length], cursor + corner * 3);
        const a = ids[corner], b = ids[(corner + 1) % 3];
        // Integer pairing stays exact (< 2^53) under the triangle cap.
        const edge = Math.min(a, b) * welded.size + Math.max(a, b);
        const previous = edges.get(edge);
        const currentCorner = cursor / 3 + corner;
        const currentNext = cursor / 3 + (corner + 1) % 3;
        if (previous === undefined) edges.set(edge, currentCorner + 1);
        else if (previous > 0) {
          const first = previous - 1;
          const firstNext = first - first % 3 + (first % 3 + 1) % 3;
          const sameDirection = idAt(first) === a;
          fans[fanRoot(currentCorner)] = fanRoot(sameDirection ? first : firstNext);
          fans[fanRoot(currentNext)] = fanRoot(sameDirection ? firstNext : first);
          edges.set(edge, 0); // Exactly two incident faces.
        } else edges.set(edge, -1); // Three or more incident faces.
      }
      cursor += 9;
    }
    let closed = true;
    for (const state of edges.values()) if (state !== 0) { closed = false; break; }
    // A closed edge count alone misses disconnected face fans at a pinched vertex.
    if (closed) {
      for (let corner = 0; corner < fans.length; corner++) {
        if (fanRoot(corner) !== fanRoot(vertices.get(idAt(corner))!)) { closed = false; break; }
      }
    }
    const part: ModelPart = {
      id: crypto.randomUUID(), name: components.size > 1 ? `${name} (${parts.length + 1})` : name,
      fileName, positions, normals, closed, visible: true, offset: [0, 0, 0],
      triangles: component.length, vertices: vertices.size,
      dimensions: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
    if (uvs?.every(Number.isFinite)) part.uvs = uvs;
    if (colors?.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      part.colors = colors;
      part.tissueScores = tissueScoresFromColors(colors);
      part.textureStatus = 'vertex-colors';
    }
    if (source) source.bindings.set(part.id, component.map(triangle => source.faceMaterials[triangle] ?? ''));
    parts.push(part);
  }
  return parts;
}

function parseWithLimits(buffer: ArrayBuffer, fileName: string, partLimit: number, triangleLimit: number, localSupport = false): ParsedImport {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  try {
    const format = extension(fileName);
    if (!buffer.byteLength) throw new Error('File is empty.');
    if (buffer.byteLength > MAX_IMPORT_BYTES) throw new Error('Import exceeds the 100 MiB input limit.');
    const sources: { geometry: BufferGeometry; name: string; faceMaterials: string[]; uvFaces?: boolean[] }[] = [];
    const name = fileName.replace(/\.[^.]+$/, '') || fileName;
    const warnings: string[] = [];
    const bindings = new Map<string, string[]>();
    const libraries: string[] = [];
    const imageReferences: string[] = [];
    let expectedTriangles: number;
    if (format === 'obj') {
      // Parse text only; OBJLoader.parse never fetches referenced materials or images.
      const text = decoder.decode(buffer).replace(/\\\r?\n/g, '').replace(/#[^\r\n]*/g, '');
      const validation = validateOBJ(text, triangleLimit);
      expectedTriangles = validation.triangles;
      for (const line of text.matchAll(/^\s*mtllib\s+([^\r\n]+)/gm)) {
        for (const path of words(line[1])) {
          if (remoteReference(path)) warnings.push(`${fileName}: remote material reference was ignored.`);
          else libraries.push(basename(path));
        }
      }
      if (!localSupport && /^\s*(mtllib|usemtl)\s+/m.test(text)) warnings.push(`${fileName}: OBJ materials and textures were ignored; import local MTL and image files together to apply them.`);
      const object = new OBJLoader().parse(text);
      let faceCursor = 0;
      object.traverse(child => {
        const renderable = child as Mesh;
        if (!renderable.geometry) return;
        geometries.add(renderable.geometry);
        for (const material of Array.isArray(renderable.material) ? renderable.material : [renderable.material]) materials.add(material);
        if (child instanceof Mesh) {
          const count = (child.geometry.getIndex()?.count ?? child.geometry.getAttribute('position').count) / 3;
          const materialList = Array.isArray(child.material) ? child.material : [child.material];
          const faceMaterials = Array<string>(count).fill(materialList[0]?.name ?? '');
          for (const group of child.geometry.groups) {
            const materialName = materialList[group.materialIndex ?? 0]?.name ?? '';
            for (let face = group.start / 3; face < (group.start + group.count) / 3; face++) faceMaterials[face] = materialName;
          }
          sources.push({ geometry: child.geometry, name: child.name || name, faceMaterials, uvFaces: validation.uvFaces.slice(faceCursor, faceCursor + count) });
          faceCursor += count;
        }
        else warnings.push(`${fileName}: points or lines were ignored; only triangle surfaces are imported.`);
      });
    } else {
      let faceUVs: Float32Array | undefined;
      let hasFaceUVs = false;
      if (format === 'stl') expectedTriangles = validateSTL(buffer, triangleLimit);
      else {
        const validation = validatePLY(buffer, triangleLimit);
        expectedTriangles = validation.triangles;
        imageReferences.push(...validation.imageReferences);
        faceUVs = validation.faceUVs;
        hasFaceUVs = validation.hasFaceUVs;
      }
      let geometry = format === 'stl' ? new STLLoader().parse(buffer) : new PLYLoader().parse(buffer);
      geometries.add(geometry);
      if (hasFaceUVs) {
        if (faceUVs) {
          // Three's PLY loader omits per-face UVs for quads. Use the same
          // triangulation order as its index buffer, without welding or moving vertices.
          if (geometry.getIndex()) { geometry = geometry.toNonIndexed(); geometries.add(geometry); }
          geometry.setAttribute('uv', new BufferAttribute(faceUVs, 2));
        } else {
          geometry.deleteAttribute('uv');
          warnings.push(`${fileName}: incomplete or non-finite PLY face UVs were ignored; no atlas mapping was invented.`);
        }
      }
      sources.push({ geometry, name, faceMaterials: [] });
    }
    const loadedTriangles = sources.reduce((total, source) => total + (source.geometry.getIndex()?.count ?? source.geometry.getAttribute('position')?.count ?? 0) / 3, 0);
    if (loadedTriangles !== expectedTriangles) throw new Error('Some faces could not be read as valid triangles. Check for incomplete solids or malformed geometry.');
    const parts: ModelPart[] = [];
    let triangles = 0;
    for (const source of sources) {
      const next = splitGeometry(source.geometry, source.name, fileName, partLimit - parts.length, triangleLimit - triangles, source.uvFaces ? { uvFaces: source.uvFaces, faceMaterials: source.faceMaterials, bindings } : undefined);
      for (const part of next) {
        parts.push(part);
        triangles += part.triangles;
        if (!part.closed) warnings.push(`${fileName}: ${part.name} is an open or non-manifold mesh; solid volume measurements may be unreliable.`);
      }
    }
    if (!parts.length) throw new Error('No triangle surface found; point clouds and lines are not supported.');
    return { parts, warnings, bindings, libraries, imageReferences };
  } catch (error) {
    throw new Error(`${fileName}: ${error instanceof Error ? error.message : 'Could not read model geometry.'}`);
  } finally {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}

export function parseModel(buffer: ArrayBuffer, fileName: string): ImportResult {
  const { parts, warnings } = parseWithLimits(buffer, basename(fileName), MAX_WORKSPACE_PARTS, MAX_WORKSPACE_TRIANGLES);
  return { parts, warnings };
}

type DecodedEvidence = TextureEvidence & { width: number; height: number };

async function readFile(file: File): Promise<ArrayBuffer> {
  try { return await file.arrayBuffer(); }
  catch { throw new Error(`${basename(file.name)}: file could not be read. Try selecting it again.`); }
}

function imageMime(fileName: string): 'image/jpeg' | 'image/png' | undefined {
  return /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : /\.png$/i.test(fileName) ? 'image/png' : undefined;
}

async function localEvidence(bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png', uvs: Float32Array): Promise<DecodedEvidence | null> {
  // Imports already run in import.worker. Attachments from the UI get a short-lived
  // worker too, so canvas readback and dense per-corner sampling stay off the UI.
  if (typeof document === 'undefined') return decodeTextureEvidence(bytes, mimeType, uvs);
  if (typeof Worker === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./texture.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Local texture decoding timed out.')); }, 30_000);
    function finish() { clearTimeout(timer); worker.terminate(); }
    worker.onmessage = ({ data }: MessageEvent<{ evidence?: DecodedEvidence | null; error?: string }>) => {
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.evidence ?? null);
    };
    worker.onerror = () => { finish(); reject(new Error('Local texture decoding worker could not run.')); };
    const inputBytes = bytes.slice(), inputUvs = uvs.slice();
    try { worker.postMessage({ bytes: inputBytes, mimeType, uvs: inputUvs }, [inputBytes.buffer, inputUvs.buffer]); }
    catch (error) { finish(); reject(error); }
  });
}

/** Attach a local atlas; absent UVs retain a reference image without inventing a mapping. */
export async function attachTexture(part: ModelPart, file: File): Promise<{ part: ModelPart; warnings: string[] }> {
  const fileName = basename(file.name);
  const mimeType = imageMime(fileName);
  if (!mimeType) throw new Error(`${fileName}: choose a JPG, JPEG, or PNG texture image.`);
  if (!file.size) throw new Error(`${fileName}: image is empty.`);
  if (file.size > MAX_TEXTURE_BYTES) throw new Error(`${fileName}: texture exceeds the 16 MiB image limit.`);
  const bytes = new Uint8Array(await readFile(file));
  if (!bytes.byteLength) throw new Error(`${fileName}: image is empty.`);
  if (bytes.byteLength > MAX_TEXTURE_BYTES) throw new Error(`${fileName}: texture exceeds the 16 MiB image limit.`);
  const texture: NonNullable<ModelPart['texture']> = { fileName, mimeType, bytes };
  const warnings: string[] = [];
  const mapped = part.uvs?.length === part.triangles * 6 && part.uvs.every(Number.isFinite);
  if (!mapped) {
    warnings.push(`${part.name}: ${fileName} is an unmapped reference image; this mesh has no complete UV coordinates. No atlas mapping was invented.`);
    return { part: { ...part, texture, textureStatus: 'unmapped' }, warnings };
  }
  // Never keep evidence from a previously attached atlas after changing its bytes.
  const next: ModelPart = { ...part, texture, textureStatus: 'mapped', colors: undefined, tissueScores: undefined };
  try {
    const evidence = await localEvidence(bytes, mimeType, part.uvs!);
    if (evidence) {
      next.colors = evidence.colors;
      next.tissueScores = evidence.tissueScores;
      texture.width = evidence.width;
      texture.height = evidence.height;
    } else warnings.push(`${part.name}: image bytes and UV mapping were kept, but local image decoding is unavailable; no texture color evidence was sampled.`);
  } catch (error) {
    warnings.push(`${part.name}: image bytes were kept, but texture color evidence could not be sampled: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { part: next, warnings };
}

type MaterialMap = { image?: string; warning?: string };

function parseMTL(text: string): Map<string, MaterialMap> {
  const maps = new Map<string, MaterialMap>();
  let material = '';
  for (const line of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const match = /^\s*(newmtl|map_Kd)\s+(.+?)\s*(?:#.*)?$/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === 'newmtl') { material = match[2].trim(); continue; }
    if (!material) continue;
    const tokens = words(match[2]);
    // Applying MTL scale/offset would alter source UVs. Keep unsupported maps
    // explicit rather than silently sampling the wrong part of an atlas.
    if (tokens[0]?.startsWith('-')) {
      maps.set(material, { warning: 'MTL map_Kd options are unsupported; the atlas was not mapped.' });
      continue;
    }
    const path = tokens.join(' ');
    if (remoteReference(path)) maps.set(material, { warning: 'Remote texture reference was ignored; only selected local images can be used.' });
    else if (path) maps.set(material, { image: basename(path) });
  }
  return maps;
}

export async function importModels(files: File[]): Promise<ImportResult> {
  if (!files.length) throw new Error('Choose at least one STL, OBJ, or PLY file.');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) throw new Error('Import exceeds the 100 MiB input limit.');
  const modelFiles: File[] = [], imageFiles: File[] = [], materialFiles: File[] = [];
  for (const file of files) {
    if (imageMime(file.name)) {
      if (file.size > MAX_TEXTURE_BYTES) throw new Error(`${basename(file.name)}: texture exceeds the 16 MiB image limit.`);
      imageFiles.push(file);
    } else if (/\.mtl$/i.test(file.name)) materialFiles.push(file);
    else { extension(file.name); modelFiles.push(file); }
  }
  if (!modelFiles.length) throw new Error('Choose at least one STL, OBJ, or PLY file alongside image and MTL support files.');
  if (modelFiles.length > MAX_WORKSPACE_PARTS) throw new Error(`Import exceeds the ${MAX_WORKSPACE_PARTS} part limit.`);
  const parts: ModelPart[] = [];
  const warnings: string[] = [];
  const materialFilesByName = new Map<string, Map<string, MaterialMap>[]>();
  for (const file of materialFiles) {
    const name = basename(file.name);
    const entries = materialFilesByName.get(name) ?? [];
    entries.push(parseMTL(decoder.decode(await readFile(file))));
    materialFilesByName.set(name, entries);
  }
  const usedImages = new Set<File>();
  function uniqueImage(name: string): File | undefined {
    const matches = imageFiles.filter(file => basename(file.name) === name);
    if (matches.length > 1) warnings.push(`${name}: duplicate local image basenames are ambiguous; no image was paired.`);
    return matches.length === 1 ? matches[0] : undefined;
  }
  let triangles = 0;
  for (const file of modelFiles) {
    const sourceFileId = crypto.randomUUID();
    const buffer = await readFile(file);
    const sourceByteSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    const fileName = basename(file.name);
    const result = parseWithLimits(buffer, fileName, MAX_WORKSPACE_PARTS - parts.length, MAX_WORKSPACE_TRIANGLES - triangles, true);
    warnings.push(...result.warnings);
    const localMaps: Map<string, MaterialMap>[] = [];
    for (const library of new Set(result.libraries)) {
      const matches = materialFilesByName.get(library) ?? [];
      if (matches.length === 1) localMaps.push(matches[0]);
      else warnings.push(`${fileName}: ${library} ${matches.length ? 'has ambiguous duplicate basenames' : 'was not selected locally'}; its materials were not resolved.`);
    }
    for (let part of result.parts) {
      part = { ...part, sourceFileId, sourceByteSha256 };
      triangles += part.triangles;
      const faceMaterials = result.bindings.get(part.id) ?? Array<string>(part.triangles).fill('');
      const byMaterial = new Map<string, File>();
      let declaredMap = false;
      for (const material of new Set(faceMaterials)) {
        const references = localMaps.flatMap(maps => maps.has(material) ? [maps.get(material)!] : []);
        if (!references.length) continue;
        declaredMap = true;
        const names = new Set(references.map(reference => reference.image));
        if (references.some(reference => reference.warning) || names.size !== 1 || names.has(undefined)) {
          warnings.push(`${part.name}: ${references.find(reference => reference.warning)?.warning ?? `Material ${material} has conflicting texture references; no atlas was paired.`}`);
          continue;
        }
        const imageName = references[0].image!;
        const image = uniqueImage(imageName);
        if (image) byMaterial.set(material, image);
        else warnings.push(`${part.name}: material ${material} needs local image ${imageName}; no unique selected image matched.`);
      }
      if (!declaredMap && result.imageReferences.length) {
        declaredMap = true;
        const references = [...new Set(result.imageReferences)];
        if (references.length !== 1) warnings.push(`${part.name}: multiple PLY TextureFile comments are ambiguous; no atlas was paired.`);
        else if (remoteReference(references[0])) warnings.push(`${part.name}: remote PLY texture reference was ignored; only selected local images can be used.`);
        else {
          const imageName = basename(references[0]);
          const image = uniqueImage(imageName);
          if (image) for (const material of new Set(faceMaterials)) byMaterial.set(material, image);
          else warnings.push(`${part.name}: PLY TextureFile needs local image ${imageName}; no unique selected image matched.`);
        }
      }
      if (!declaredMap) {
        const names = new Set([stem(fileName), part.name.replace(/ \(\d+\)$/, ''), ...faceMaterials.filter(Boolean)]);
        const matches = imageFiles.filter(image => names.has(stem(image.name)));
        if (matches.length === 1) {
          for (const material of new Set(faceMaterials)) byMaterial.set(material, matches[0]);
        } else if (matches.length > 1) warnings.push(`${part.name}: several images match exact mesh/material basenames; attach the intended atlas explicitly.`);
      }
      const images = [...new Set(byMaterial.values())];
      if (images.length === 1 && faceMaterials.every(material => byMaterial.get(material) === images[0])) {
        usedImages.add(images[0]);
        const attached = await attachTexture(part, images[0]);
        part = attached.part;
        warnings.push(...attached.warnings);
      } else if (images.length) {
        // A connected mesh can have several material atlases. Preserve its face
        // order/topology and bake each material's colors only onto its own faces.
        const colors = part.colors?.slice() ?? new Float32Array(part.positions.length).fill(0.72);
        const scores = part.tissueScores?.slice() ?? new Float32Array(part.triangles).fill(-1);
        let sampled = false;
        let reference: ModelPart['texture'];
        for (const image of images) {
          usedImages.add(image);
          const attached = await attachTexture(part, image);
          reference ??= attached.part.texture;
          warnings.push(...attached.warnings);
          if (!attached.part.colors || !attached.part.tissueScores || attached.part.textureStatus !== 'mapped') continue;
          sampled = true;
          for (let face = 0; face < part.triangles; face++) if (byMaterial.get(faceMaterials[face]) === image) {
            colors.set(attached.part.colors.subarray(face * 9, face * 9 + 9), face * 9);
            scores[face] = attached.part.tissueScores[face];
          }
        }
        if (sampled) part = { ...part, colors, tissueScores: scores, textureStatus: 'mapped' };
        else {
          part = { ...part, texture: reference, textureStatus: 'unmapped' };
          warnings.push(`${part.name}: multiple material images need local decoding to combine; the first image was kept as an unmapped reference and no complete image mapping was applied.`);
        }
      }
      parts.push(part);
    }
  }
  for (const file of imageFiles) if (!usedImages.has(file)) warnings.push(`${basename(file.name)}: no unique local mesh/material basename matched; attach this reference image to a selected part.`);
  return { parts, warnings };
}
