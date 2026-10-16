import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inputGuard,validateConfiguration} from '../src/security.js';
import {safeLink} from '../src/models.js';
import {listenOptions} from '../src/listen-options.js';
import http from 'node:http';
test('production binds publicly and respects the hosting PORT',async()=>{
 assert.deepEqual(listenOptions({NODE_ENV:'production',PORT:'10000'}),{host:'0.0.0.0',port:10000});
 assert.deepEqual(listenOptions({NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4000'}),{host:'0.0.0.0',port:4000});
 assert.deepEqual(listenOptions({}),{host:'127.0.0.1',port:4000});
 for(const PORT of ['no-port','-1','0','65536','12.5'])assert.throws(()=>listenOptions({PORT}));
 const server=http.createServer((req,res)=>res.end('ready'));
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({...listenOptions({NODE_ENV:'production'}),port:0},resolve);});
  assert.equal(server.address().address,'0.0.0.0');
  assert.equal(await (await fetch('http://127.0.0.1:'+server.address().port)).text(),'ready');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('rejects query operators, prototype keys and invalid bodies',()=>{
 for(const body of [null,[],{$where:'bad'},JSON.parse('{"__proto__":{"admin":true}}'),{email:{$ne:null}},{a:'\0'}]){
  let status;inputGuard({body,query:{}},{status:s=>({json:()=>status=s})},()=>{status=200;});assert.equal(status,400);
 }
 let ok=false;inputGuard({body:{name:'<script>alert(1)</script>',items:[{quantity:1}]},query:{}},{},()=>ok=true);assert(ok);
});
test('rejects executable URLs, encoded controls and credential-bearing links',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','//evil.example','/\\evil.example','https://user:pass@evil.example','/x%0d%0aevil','https://example.com/%5cfoo'])assert.equal(safeLink(url),false,url);
 for(const url of ['/shop?category=fragrances','https://splinxstudio.com','mailto:hello@example.com','tel:+923001234567'])assert.equal(safeLink(url),true,url);
});
test('production configuration fails closed on weak secrets, public databases and debugging',()=>{
 const base={JWT_SECRET:'a'.repeat(64),MONGODB_URI:'mongodb://app:password@db.example/mivorax?tls=true',CLIENT_ORIGINS:'https://shop.example',NODE_ENV:'production'};
 assert.doesNotThrow(()=>validateConfiguration(base));
 for(const patch of [{JWT_SECRET:'short'},{MONGODB_URI:'mongodb://db.example/mivorax'},{CLIENT_ORIGINS:'http://shop.example'},{TRUST_PROXY_HOPS:'true'},{DEBUG:'*'},{NODE_OPTIONS:'--inspect'}])assert.throws(()=>validateConfiguration({...base,...patch}));
});
