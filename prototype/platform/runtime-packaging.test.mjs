import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// A fast local guard for the explicit production allowlist. CI still builds and
// imports the actual non-root Docker image; this is not a substitute for it.
test('control Docker allowlist contains the complete local runtime import graph',async()=>{
 const docker=await readFile(new URL('./Dockerfile.control',import.meta.url),'utf8');
 const included=new Set(docker.split('\n').filter(line=>line.startsWith('COPY ')).flatMap(line=>line.split(/\s+/).filter(word=>word.endsWith('.mjs'))));
 const visited=new Set(),queue=['control-server.mjs'];
 while(queue.length){
  const name=queue.pop();if(visited.has(name))continue;visited.add(name);
  assert.ok(included.has(name),`Missing production COPY entry: ${name}`);
  const source=await readFile(new URL(name,import.meta.url),'utf8');
  for(const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]\.\/([^'"]+\.mjs)['"]/g))queue.push(match[1]);
 }
 assert.ok(visited.has('courier-service.mjs'),'Courier service must be checked as part of the runtime graph');
 assert.match(docker,/^USER node$/m);
});
