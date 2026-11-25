'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const THREE_ROOT = path.join(ROOT, 'node_modules', 'three');
const JSM_ROOT = path.join(THREE_ROOT, 'examples', 'jsm');
const OUT_ROOT = path.join(ROOT, 'src', 'web', 'public', 'vendor', 'three');
const OUT_ADDONS = path.join(OUT_ROOT, 'addons');

const SEED_ADDONS = [
  'controls/OrbitControls.js',
  'loaders/GLTFLoader.js',
  'environments/RoomEnvironment.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js'
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function copyCore() {
  ensureDir(OUT_ROOT);
  fs.copyFileSync(path.join(THREE_ROOT, 'LICENSE'), path.join(OUT_ROOT, 'LICENSE'));

  const coreFiles = ['three.module.js', 'three.core.js'];
  for (const name of coreFiles) {
    const src = path.join(THREE_ROOT, 'build', name);
    if (!fs.existsSync(src)) throw new Error(`Missing Three.js build file: ${src}`);
    fs.copyFileSync(src, path.join(OUT_ROOT, name));
  }

  const moduleSrc = fs.readFileSync(path.join(OUT_ROOT, 'three.module.js'), 'utf8');
  const relImports = [...moduleSrc.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
  for (const spec of relImports) {
    const expected = path.resolve(OUT_ROOT, spec);
    if (!fs.existsSync(expected)) {
      throw new Error(`Missing core dependency referenced by three.module.js: ${spec}`);
    }
  }
}

function extractModuleSpecifiers(code) {
  const specs = [];
  const pattern = /(?:^|[\s;{}(),])(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1|import\s*\(\s*(['"])([^'"]+)\3\s*\)|import\s*(['"])([^'"]+)\5/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const spec = match[2] || match[4] || match[6];
    if (spec) specs.push(spec);
  }
  return specs;
}

function rewriteAddonImports(code, addonRelPosix) {
  const addonDirInOut = path.posix.dirname(path.posix.join('addons', addonRelPosix));
  const relToModule = path.posix.relative(addonDirInOut, 'three.module.js');

  const rewriteSpec = spec => {
    if (spec === 'three') return relToModule;
    if (spec.startsWith('three/addons/')) {
      const target = path.posix.join('addons', spec.slice('three/addons/'.length));
      const rel = path.posix.relative(addonDirInOut, target);
      return rel.startsWith('.') ? rel : `./${rel}`;
    }
    return spec;
  };

  return code.replace(
    /(\bfrom\s*)(['"])([^'"]+)\2/g,
    (_, prefix, quote, spec) => `${prefix}${quote}${rewriteSpec(spec)}${quote}`
  );
}

function collectAndWriteAddons() {
  const visited = new Set();
  const queue = [...SEED_ADDONS];

  while (queue.length > 0) {
    const relPosix = queue.shift();
    if (visited.has(relPosix)) continue;
    visited.add(relPosix);

    const srcFile = path.join(JSM_ROOT, ...relPosix.split('/'));
    if (!fs.existsSync(srcFile)) {
      throw new Error(`Missing Three.js addon: ${srcFile}`);
    }

    const raw = fs.readFileSync(srcFile, 'utf8');
    const specs = extractModuleSpecifiers(raw);
    for (const spec of specs) {
      if (spec === 'three') continue;
      if (spec.startsWith('three/addons/')) {
        queue.push(spec.slice('three/addons/'.length));
        continue;
      }
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPosix), spec));
        if (resolved.startsWith('..')) {
          throw new Error(`Addon import escapes examples/jsm: ${relPosix} -> ${spec}`);
        }
        queue.push(resolved);
        continue;
      }
      throw new Error(`Unsupported bare import "${spec}" in ${relPosix}`);
    }

    const rewritten = rewriteAddonImports(raw, relPosix);
    const unresolvedBare = extractModuleSpecifiers(rewritten).filter(
      spec => !spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')
    );
    if (unresolvedBare.length > 0) {
      throw new Error(`Unresolved bare specifiers in ${relPosix}: ${unresolvedBare.join(', ')}`);
    }

    const outFile = path.join(OUT_ADDONS, ...relPosix.split('/'));
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, rewritten, 'utf8');
  }

  return [...visited].sort();
}

function main() {
  if (fs.existsSync(OUT_ROOT)) {
    fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  }
  copyCore();
  const addons = collectAndWriteAddons();
  console.log(`Vendored Three.js core + ${addons.length} addon files into ${toPosix(path.relative(ROOT, OUT_ROOT))}`);
  for (const file of addons) console.log(`  - addons/${file}`);
}

main();
