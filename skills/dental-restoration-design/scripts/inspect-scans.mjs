#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModel, MAX_IMPORT_BYTES, MAX_WORKSPACE_PARTS, MAX_WORKSPACE_TRIANGLES } from '../../../src/import-models.ts';
import { meshBounds, IDENTITY_MATRIX } from './dental-concept.mjs';

// The scripts directory is three levels below the repository root.
// Keep imports relative so this works from any process working directory.
export const INSPECTION_SCHEMA = 'dental-scan-inventory/v1';
export const sha256Id = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** No registration, normalization, unit inference, or patient file copying. */
export function inspectScanBytes(bytes, fileName, role) {
  if (!['upper', 'lower', 'bite'].includes(role)) throw new Error('Scan role must be upper, lower, or bite.');
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { parts, warnings } = parseModel(data, fileName);
  const id = sha256Id(new Uint8Array(data));
  const inventoryParts = parts.map((part, index) => ({
    id: `${id}/part/${index}`, name: part.name, triangleCount: part.triangles,
    vertexCount: part.vertices, closed: part.closed, bounds: meshBounds(part.positions),
  }));
  const min = [0, 1, 2].map(a => Math.min(...inventoryParts.map(p => p.bounds.min[a])));
  const max = [0, 1, 2].map(a => Math.max(...inventoryParts.map(p => p.bounds.max[a])));
  return {
    inventory: {
      id, fileName: basename(fileName), role, byteLength: data.byteLength,
      units: { status: 'unknown', name: null, provenance: 'STL/OBJ/PLY geometry alone does not establish physical units.' },
      fileToWorld: [...IDENTITY_MATRIX], coordinatePreserving: true,
      coordinatePrecision: 'Existing importer uses Float32; coordinates are not recentered or rescaled.',
      bounds: { min, max, size: min.map((v, a) => max[a] - v) },
      triangleCount: parts.reduce((sum, p) => sum + p.triangles, 0),
      closed: parts.every(p => p.closed), parts: inventoryParts, warnings,
      closureMeaning: 'Edge incidence and vertex-fan test; not proof of no self-intersection or clinical integrity.',
    },
    // Importer-generated random IDs deliberately do not enter saved inventory.
    parts: parts.map((part, i) => ({ ...part, id: inventoryParts[i].id, role, sourceId: id })),
  };
}

export async function inspectLocalScans(entries, { checkCancelled = () => {} } = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_WORKSPACE_PARTS) throw new Error('Provide 1–64 local scan entries.');
  let bytes = 0, triangles = 0, count = 0;
  const scans = [], parts = [];
  for (const entry of entries) {
    checkCancelled();
    if (!entry || typeof entry.path !== 'string' || !['upper', 'lower', 'bite'].includes(entry.role)) throw new Error('Each scan entry needs a local path and upper/lower/bite role.');
    const info = await stat(entry.path);
    if (!info.isFile() || (bytes += info.size) > MAX_IMPORT_BYTES) throw new Error('Input must be local files totaling at most 100 MiB.');
    const buffer = await readFile(entry.path);
    const result = inspectScanBytes(buffer, basename(entry.path), entry.role);
    triangles += result.inventory.triangleCount; count += result.parts.length;
    if (triangles > MAX_WORKSPACE_TRIANGLES || count > MAX_WORKSPACE_PARTS) throw new Error('Inventory exceeds importer triangle/part budgets.');
    scans.push(result.inventory);
    parts.push(...result.parts.map(p => ({ ...p, role: entry.role, sourceId: result.inventory.id })));
    checkCancelled();
  }
  return {
    inventory: { schemaVersion: INSPECTION_SCHEMA, coordinatePreserving: true, registration: 'none',
      distanceUnit: 'file units', sourceByteTotal: bytes, triangleCount: triangles, scans,
      limitations: ['Upper/lower/bite are caller-assigned roles, not anatomical inference.', 'Bite files are not automatically registered.', 'Bounds use importer Float32 coordinates.', 'Open IOS surfaces are expected; closed status does not establish clinical suitability.'] },
    parts,
  };
}

/** A deterministic bounded triangle sample, still expressed in global coordinates. */
export function createPreviewData(parts, maxTriangles = 6000) {
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > 20_000) throw new Error('Preview budget must be an integer in [1, 20000].');
  const total = parts.reduce((sum, p) => sum + p.positions.length / 9, 0);
  const stride = Math.max(1, Math.ceil(total / maxTriangles));
  let index = 0, sampled = 0;
  const meshes = parts.map(part => {
    const positions = [];
    for (let i = 0; i < part.positions.length; i += 9, index++) if (index % stride === 0) {
      positions.push(...part.positions.subarray(i, i + 9)); sampled++;
    }
    return { id: part.id, sourceId: part.sourceId, name: part.name, role: part.role,
      positions, bounds: meshBounds(part.positions), originalTriangleCount: part.positions.length / 9 };
  });
  return { schemaVersion: 'dental-preview/v1', coordinateSystem: 'original-file-coordinates', distanceUnit: 'file units',
    sampled: sampled < total, originalTriangleCount: total, displayedTriangleCount: sampled, meshes };
}

/** Self-contained local canvas preview. Only the viewing camera is centered. */
export function createPreviewHTML(data) {
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local mesh inspection</title>
<style>*{box-sizing:border-box}body{margin:0;font:15px system-ui;background:#f1f5f9;color:#334155}header{padding:16px 22px;background:#fff;border-bottom:1px solid #cbd5e1}h1{font-size:20px;margin:0 0 6px}p{margin:5px 0}button{padding:7px 12px;background:#e0f2fe;border:1px solid #7dd3fc;border-radius:5px;color:#0c4a6e}canvas{width:100%;height:75vh;display:block;touch-action:none}label{margin-right:16px;white-space:nowrap}#legend{padding:10px 22px}</style>
<header><h1>Local mesh inspection</h1><p id="summary"></p><p>Drag to orbit · wheel to zoom · file units · original geometry coordinates</p><p>Sampled triangles can omit small features. This view does not assess fit or collision.</p><button id="reset">Reset view</button><div id="legend"></div></header><canvas aria-label="Interactive 3D mesh preview"></canvas>
<script type="application/json" id="data">${json}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
document.getElementById('summary').textContent=data.displayedTriangleCount+' / '+data.originalTriangleCount+' triangles displayed'+(data.sampled?' (sampled)':'');
const colors={upper:'#38bdf8',lower:'#a78bfa',bite:'#94a3b8',concept:'#f59e0b'},enabled=data.meshes.map(()=>true);
const min=[0,1,2].map(a=>Math.min(...data.meshes.map(m=>m.bounds.min[a]))),max=[0,1,2].map(a=>Math.max(...data.meshes.map(m=>m.bounds.max[a]))),center=min.map((v,a)=>(v+max[a])/2),extent=Math.hypot(...min.map((v,a)=>max[a]-v))||1;
let yaw=-0.5,pitch=0.65,zoom=1,drag=null;
data.meshes.forEach((m,i)=>{const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=true;input.onchange=()=>{enabled[i]=input.checked;draw()};label.style.color=colors[m.role]||'#0284c7';label.append(input,document.createTextNode(m.role+' · '+m.name));document.getElementById('legend').append(label)});
function project(x,y,z){x-=center[0];y-=center[1];z-=center[2];const u=x*Math.cos(yaw)-y*Math.sin(yaw),v=x*Math.sin(yaw)+y*Math.cos(yaw);return[u,v*Math.cos(pitch)-z*Math.sin(pitch),v*Math.sin(pitch)+z*Math.cos(pitch)]}
function draw(){const w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#f1f5f9';ctx.fillRect(0,0,w,h);const scale=Math.min(w,h)*0.85/extent*zoom,triangles=[];data.meshes.forEach((m,i)=>{if(!enabled[i])return;for(let j=0;j<m.positions.length;j+=9){const p=[0,3,6].map(k=>project(...m.positions.slice(j+k,j+k+3)));triangles.push({p,color:colors[m.role]||'#0284c7',depth:p.reduce((s,v)=>s+v[2],0)})}});triangles.sort((a,b)=>a.depth-b.depth);for(const t of triangles){const u=t.p[1].map((v,a)=>v-t.p[0][a]),v=t.p[2].map((v,a)=>v-t.p[0][a]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],light=0.45+0.55*Math.abs(n[2])/(Math.hypot(...n)||1),rgb=[1,3,5].map(i=>Math.round(parseInt(t.color.slice(i,i+2),16)*light));ctx.beginPath();t.p.forEach((p,i)=>{const x=w/2+p[0]*scale,y=h/2-p[1]*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath();ctx.globalAlpha=1;ctx.fillStyle='rgb('+rgb.join(',')+')';ctx.fill();ctx.globalAlpha=0.2;ctx.strokeStyle='#334155';ctx.lineWidth=0.5;ctx.stroke()}ctx.globalAlpha=1;ctx.fillStyle='#475569';ctx.fillText('Camera centered for display only. Data retains global coordinates.',16,h-16)}
canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId)};canvas.onpointerup=()=>drag=null;canvas.onpointercancel=()=>drag=null;canvas.onpointermove=e=>{if(!drag)return;yaw+=(e.clientX-drag[0])*0.008;pitch=Math.max(-1.55,Math.min(1.55,pitch+(e.clientY-drag[1])*0.008));drag=[e.clientX,e.clientY];draw()};canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.1,Math.min(20,zoom*Math.exp(-e.deltaY*0.001)));draw()},{passive:false});document.getElementById('reset').onclick=()=>{yaw=-0.5;pitch=0.65;zoom=1;draw()};window.onresize=draw;draw();
</script></html>`;
}

export async function createOutputDirectory(path) {
  const directory = resolve(path);
  await mkdir(dirname(directory), { recursive: true });
  // Deliberately refuse existing directories instead of replacing artifacts.
  await mkdir(directory);
  return directory;
}

const HELP = `Inspect local IOS geometry without registration or unit conversion.
Usage (from repository root):
  node --experimental-strip-types skills/dental-restoration-design/scripts/inspect-scans.mjs \\
    --upper /private/upper.ply --lower /private/lower.stl --bite /private/bite.obj --out /tmp/ios-inspection
Repeat role flags for multiple files; at least one is required. --out must be a NEW directory.
Writes inventory.json, preview.json, and a self-contained preview.html. No raw files are copied.
SHA256 IDs are hashes of the original bytes. Bounds use the existing Float32 importer.
Roles are caller labels. Distances are file units; physical units remain unknown. Open meshes and bite alignment are not repaired.
Preview includes at most 6000 sampled triangles; it is not a clinical or collision assessment.
Keep patient files and derived previews outside git. --help prints this message.
API: inspectScanBytes(bytes, name, role); inspectLocalScans([{path, role}]); createPreviewData(parts).`;

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log(HELP); return; }
  const entries = []; let out;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}. Use --help.`);
    if (['--upper', '--lower', '--bite'].includes(flag)) entries.push({ role: flag.slice(2), path: value });
    else if (flag === '--out' && !out) out = value;
    else throw new Error(`Unsupported or repeated option ${flag}. Use --help.`);
  }
  if (!out || !entries.length) throw new Error('Provide scan role flags and --out. Use --help.');
  const { inventory, parts } = await inspectLocalScans(entries);
  const preview = createPreviewData(parts), directory = await createOutputDirectory(out);
  await writeFile(resolve(directory, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  await writeFile(resolve(directory, 'preview.json'), `${JSON.stringify(preview)}\n`, { flag: 'wx' });
  await writeFile(resolve(directory, 'preview.html'), createPreviewHTML(preview), { flag: 'wx' });
  console.log(JSON.stringify({ directory, scans: inventory.scans.length, triangles: inventory.triangleCount, distanceUnit: 'file units' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
