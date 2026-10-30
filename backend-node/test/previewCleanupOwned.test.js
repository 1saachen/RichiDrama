const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'../..');
const posix=p=>p.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase());
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-preview-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scripts=path.join(dir,'scripts'),previews=path.join(dir,'previews'),bin=path.join(dir,'bin');for(const p of [scripts,previews,bin])fs.mkdirSync(p);
 for(const file of ['lib.sh','preview-cleanup-owned','preview-cleanup-entrypoint','preview-deploy'])fs.writeFileSync(path.join(scripts,file),fs.readFileSync(path.join(root,'deploy',file),'utf8').replace(/\r/g,''));
 const shim=`#!/usr/bin/env bash
case "$1" in
 ps) [[ "\$FAIL_DOCKER" == 1 ]] && exit 1; [[ "$*" == *'-aq'* && "\$HAS_CONTAINER" == 1 ]] && echo abc123; exit 0 ;;
 inspect) echo "\$CONTAINER_OWNER" ;;
 rm) printf '%s\\n' "$*" >> "\$DOCKER_LOG" ;;
 *) exit 1 ;;
esac
`;
 fs.writeFileSync(path.join(bin,'docker'),shim,{mode:0o755});fs.writeFileSync(path.join(dir,'production-sentinel'),'keep');
 const f={dir,previews,add(n,options={}){
  const p=path.join(previews,'pr-'+n);fs.mkdirSync(p);const {owner='1saachen/RichiDrama',policy='1',created=Math.floor(Date.now()/1000)-20000,pr=n}=options;
  fs.writeFileSync(path.join(p,'metadata.env'),`PR_NUMBER=${pr}\nSOURCE_REPOSITORY=${owner}\nPREVIEW_CLEANUP_POLICY_VERSION=${policy}\nCREATED_AT=${created}\nPASSWORD=fixture-secret-must-not-log\n`);return p;
 },run(args=[],env={},script='preview-cleanup-owned'){
  const vars={MINIDRAMA_PREVIEW_ROOT:posix(previews),MINIDRAMA_DEPLOY_LOCK:posix(path.join(dir,'lock')),MINIDRAMA_PREVIEW_TTL_SECONDS:'10000',DOCKER_LOG:posix(path.join(dir,'docker.log')),HAS_CONTAINER:'0',FAIL_DOCKER:'0',CONTAINER_OWNER:'1saachen/RichiDrama',...env};
  const exports=Object.entries(vars).map(([k,v])=>'export '+k+'='+quote(v)).join('\n');
  const command=`${exports}\nexport PATH=${quote(posix(bin))}:"$PATH"\nid(){ echo 0; }; flock(){ return 0; }; export -f id flock\nbash ${quote(posix(path.join(scripts,script)))} ${args.map(quote).join(' ')}`;
  return spawnSync('bash',['-c',command],{encoding:'utf8'});
 }};return f;
}
test('owned preview dry-run excludes legacy, foreign, fresh and unopted records without writes',t=>{
 const f=fixture(t);for(const [n,opts]of [[1,{}],[2,{created:Math.floor(Date.now()/1000)}],[3,{owner:''}],[4,{owner:'other/repo'}],[5,{policy:'0'}]])f.add(n,opts);
 const r=f.run(['--repository','1saachen/RichiDrama']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/eligible=1 apply=0/);assert.doesNotMatch(r.stdout+r.stderr,/fixture-secret/);
 for(const n of [1,2,3,4,5])assert.ok(fs.existsSync(path.join(f.previews,'pr-'+n)));assert.ok(!fs.existsSync(path.join(f.dir,'docker.log')));
});
test('apply removes only explicit owned expired preview; production and foreign directories survive',t=>{
 const f=fixture(t);f.add(1);f.add(2,{owner:'other/repo'});const r=f.run(['--repository','1saachen/RichiDrama','--apply'],{HAS_CONTAINER:'1'});
 assert.equal(r.status,0,r.stderr);assert.ok(!fs.existsSync(path.join(f.previews,'pr-1')));assert.ok(fs.existsSync(path.join(f.previews,'pr-2')));assert.equal(fs.readFileSync(path.join(f.dir,'production-sentinel'),'utf8'),'keep');assert.match(fs.readFileSync(path.join(f.dir,'docker.log'),'utf8'),/^rm -f abc123/);
});
test('closed PR cleanup selects the exact owned PR even before TTL expiry',t=>{
 const f=fixture(t);f.add(1);f.add(2,{created:Math.floor(Date.now()/1000)});const r=f.run(['--repository','1saachen/RichiDrama','--pr','2','--dry-run']);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/eligible=1/);assert.match(r.stderr,/PR 2/);assert.doesNotMatch(r.stderr,/PR 1/);
});
for(const [label,env]of [['Docker unavailable',{FAIL_DOCKER:'1'}],['foreign container',{HAS_CONTAINER:'1',CONTAINER_OWNER:'other/repo'}]])test('cleanup fails closed: '+label,t=>{
 const f=fixture(t);f.add(1);const r=f.run(['--repository','1saachen/RichiDrama','--apply'],env);assert.notEqual(r.status,0);assert.ok(fs.existsSync(path.join(f.previews,'pr-1')));assert.ok(!fs.existsSync(path.join(f.dir,'docker.log')));
});
test('mismatched metadata path and missing repository cannot cause deletion',t=>{
 const f=fixture(t);f.add(1,{pr:9});assert.notEqual(f.run(['--repository','1saachen/RichiDrama','--apply']).status,0);assert.notEqual(f.run(['--apply']).status,0);assert.ok(fs.existsSync(path.join(f.previews,'pr-1')));
});
test('forced SSH command rejects arbitrary shell text',t=>{
 const f=fixture(t);for(const command of ['uname -a','report-expired; touch injected','report-closed 1\nwhoami','remove-closed ../1']){const r=f.run([],{SSH_ORIGINAL_COMMAND:command},'preview-cleanup-entrypoint');assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/Only preview cleanup/);}
});
test('new-repository preview creation refuses a foreign PR before building or deleting',t=>{
 const f=fixture(t);f.add(1,{owner:'old/repo'});const r=f.run(['1','a'.repeat(40)],{MINIDRAMA_PREVIEW_SOURCE_REPOSITORY:'1saachen/RichiDrama'},'preview-deploy');assert.notEqual(r.status,0);assert.match(r.stderr,/explicit migration required/);assert.ok(fs.existsSync(path.join(f.previews,'pr-1')));assert.ok(!fs.existsSync(path.join(f.dir,'docker.log')));
});
