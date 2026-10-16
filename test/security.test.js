import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inputGuard,validateConfiguration} from '../src/security.js';
import {safeLink} from '../src/models.js';
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
