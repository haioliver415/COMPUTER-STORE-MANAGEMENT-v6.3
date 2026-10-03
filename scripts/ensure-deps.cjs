const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const pkg=require(path.join(root,'package.json'));
const names=[...Object.keys(pkg.dependencies||{}),...Object.keys(pkg.devDependencies||{})];
const missing=names.filter(n=>!fs.existsSync(path.join(root,'node_modules',n)));
if(!missing.length){console.log('[CSMS] Dependencies ready.');process.exit(0);}
console.log('[CSMS] Missing dependencies:',missing.join(', '));
console.log('[CSMS] Installing dependencies automatically...');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const r=spawnSync(npm,['install'],{cwd:root,stdio:'inherit',shell:false});
if(r.status!==0){console.error('[CSMS] npm install failed. Run npm install manually.');process.exit(r.status||1);}
