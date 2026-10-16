import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import {existsSync,readFileSync} from 'node:fs';
import {createApp} from '../src/app.js';
import {seedDatabase} from '../src/initialize.js';
import {Admin,Category,Product,Order,Setting,Subscriber} from '../src/models.js';
import {validateConfiguration} from '../src/security.js';
const privateFile=new URL('../.security/database-admin.json',import.meta.url);
const uri=process.env.MONGODB_TEST_URI||(process.env.MONGODB_URI?.includes('@127.0.0.1:27018/')&&existsSync(privateFile)?JSON.parse(readFileSync(privateFile,'utf8')).adminUri:process.env.MONGODB_URI);
test('controlled local penetration tests', {skip:!uri,timeout:120000},async t=>{
 const database='mivorax_pentest_'+crypto.randomBytes(10).toString('hex');
 await mongoose.connect(uri,{dbName:database,serverSelectionTimeoutMS:5000});
 let server;
 try{
  const secret=crypto.randomBytes(48).toString('hex'),email='pentest@example.test',password=crypto.randomBytes(24).toString('hex');
  await seedDatabase({email,password,includeSamples:false});
  await Category.create({name:'Test',slug:'pentest',status:'published'});
  const product=await Product.create({name:'Test fragrance',slug:'pentest-product',category:'pentest',price:1000,stock:100,status:'published',demo:false});
  await Setting.updateOne({key:'store'},{$set:{'value.checkoutEnabled':true,'value.codEnabled':true}});
  await Order.init();
  server=createApp({secret}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  let token;
  async function req(path,{method='GET',body,auth=false,headers={}}={}){
   const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
   const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,headers:r.headers};
  }
  token=(await req('/api/admin/login',{method:'POST',body:{email,password}})).data.token;assert(token);
  const checkout=()=>({customer:{name:'Penetration test',email:'buyer@example.test',phone:'03001234567',address:'Test address',city:'Lahore',country:'Pakistan'},items:[{productId:String(product._id),quantity:1,unitPrice:1}],paymentMethod:'cod',total:1,status:'delivered'});
  await t.test('anonymous authorization matrix and token forgery',async()=>{
   const routes=[['GET','dashboard'],['GET','orders'],['GET','customers'],['GET','subscribers'],['GET','audit'],['GET','images'],['POST','products'],['PUT','site'],['PUT','settings'],['POST','password'],['POST','logout'],['PUT','orders/'+product._id],['POST','products/'+product._id+'/archive']];
   for(const [method,path]of routes)assert.equal((await req('/api/admin/'+path,{method,body:method==='GET'?undefined:{}})).status,401,path);
   const admin=await Admin.findOne({email});
   for(const forged of [jwt.sign({role:'admin'},secret,{algorithm:'HS256',subject:String(admin._id),issuer:'wrong',audience:'mivorax-admin'}),jwt.sign({role:'admin'},'wrong-secret',{algorithm:'HS256'}),'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.'])assert.equal((await req('/api/admin/dashboard',{headers:{Authorization:'Bearer '+forged}})).status,401);
   await Admin.updateOne({_id:admin._id},{$set:{disabled:true}});assert.equal((await req('/api/admin/dashboard',{auth:true})).status,401);await Admin.updateOne({_id:admin._id},{$set:{disabled:false}});
  });
  await t.test('operator injection, prototype pollution and malformed types',async()=>{
   for(const payload of [{$where:'sleep(5000)'},{email:{$ne:null},password:{$ne:null}},JSON.parse('{"__proto__":{"role":"admin"}}'),{email:{constructor:'x'},password:'x'}])assert.equal((await req('/api/admin/login',{method:'POST',body:payload})).status,400);
   const r=await req('/api/newsletter',{method:'POST',body:{email:['injected@example.test'],consent:true}});assert.equal(r.status,400,'array-valued email must not create a subscriber');assert.equal(await Subscriber.countDocuments({email:'injected@example.test'}),0);
  });
  await t.test('malformed pagination cannot reach database operations',async()=>{
   for(const query of ['page=1.5','limit=1.5','page=Infinity','limit=NaN','page=1&page=2'])assert.equal((await req('/api/admin/products?'+query,{auth:true})).status,400,query);
  });
  await t.test('order replay cannot create multiple purchases or consume stock twice',async()=>{
   const body=checkout(),key=crypto.randomUUID(),before=(await Product.findById(product._id)).stock;
   const results=await Promise.all([req('/api/orders',{method:'POST',body,headers:{'Idempotency-Key':key}}),req('/api/orders',{method:'POST',body,headers:{'Idempotency-Key':key}})]);
   assert(results.every(r=>[200,201].includes(r.status)),JSON.stringify(results));
   assert.equal(results[0].data.reference,results[1].data.reference,'same request was processed twice');
   assert.equal((await Product.findById(product._id)).stock,before-1);
   assert.equal(results[0].data.total,1250);assert.equal(results[0].data.status,'confirmed');
   const tracking=await req('/api/orders/track',{method:'POST',body:{reference:results[0].data.reference,token:results[0].data.token}});assert.equal(tracking.status,200);assert.equal(tracking.data.customer,undefined);assert.equal(tracking.data.trackingHash,undefined);
   assert.equal((await req('/api/orders/track',{method:'POST',body:{reference:results[0].data.reference,token:crypto.randomBytes(24).toString('hex')}})).status,404);
   assert.equal((await req('/api/orders',{method:'POST',body:{...body,items:[{productId:String(product._id),quantity:2}]},headers:{'Idempotency-Key':key}})).status,409);
  });
  await t.test('replay protection survives API replacement and a last-stock race',async()=>{
   await Product.updateOne({_id:product._id},{$set:{stock:1}});
   const key=crypto.randomUUID(),body=checkout();
   const pair=await Promise.all([req('/api/orders',{method:'POST',body,headers:{'Idempotency-Key':key}}),req('/api/orders',{method:'POST',body,headers:{'Idempotency-Key':key}})]);
   assert(pair.every(r=>[200,201].includes(r.status)),JSON.stringify(pair));assert.equal(pair[0].data.reference,pair[1].data.reference);assert.equal((await Product.findById(product._id)).stock,0);
   const other=createApp({secret}).listen(0,'127.0.0.1');await new Promise(r=>other.on('listening',r));
   try{const replay=await fetch('http://127.0.0.1:'+other.address().port+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});assert.equal(replay.status,200);assert.equal((await replay.json()).token,pair[0].data.token);}finally{await new Promise(r=>other.close(r));}
   assert.equal((await req('/api/orders',{method:'POST',body})).status,400);
   await Product.updateOne({_id:product._id},{$set:{stock:50}});
  });
  await t.test('negative quantities, type confusion and mass assignment cannot change totals or stock',async()=>{
   const before=(await Product.findById(product._id)).stock;
   for(const quantity of [-1,0,1.5,11,'1',{$gt:0}])assert.equal((await req('/api/orders',{method:'POST',body:{...checkout(),items:[{productId:String(product._id),quantity}]},headers:{'Idempotency-Key':crypto.randomUUID()}})).status,400);
   assert.equal((await Product.findById(product._id)).stock,before);
   const draft=await Product.create({name:'Private test draft',slug:'private-test-draft',category:'pentest',price:1,stock:1,status:'draft'});
   assert(!(await req('/api/products')).data.some(p=>p._id===String(draft._id)));
   assert.equal((await req('/api/orders',{method:'POST',body:{...checkout(),items:[{productId:String(draft._id),quantity:1}]},headers:{'Idempotency-Key':crypto.randomUUID()}})).status,400);
  });
  await t.test('hostile uploads rejected and appended script stripped',async()=>{
   for(const [data,name]of [[Buffer.from('<svg onload="alert(1)"/>'),'x.svg'],[Buffer.from([137,80,78,71,13,10,26,10]),'fake.png']]){const form=new FormData();form.append('image',new Blob([data]),name);assert.equal((await fetch(base+'/api/admin/images',{method:'POST',headers:{Authorization:'Bearer '+token},body:form})).status,400);}
   const payload='PENTEST_SCRIPT_SENTINEL';const png=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();const form=new FormData();form.append('image',new Blob([Buffer.concat([png,Buffer.from('<script>'+payload+'</script>')])]),'polyglot.png');
   const r=await fetch(base+'/api/admin/images',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});assert.equal(r.status,201);const saved=await r.json();const image=await fetch(base+saved.url);assert(!(Buffer.from(await image.arrayBuffer())).includes(Buffer.from(payload)));
  });
  await t.test('CORS, file traversal, parser and response-header defenses',async()=>{
   for(const origin of ['null','https://evil.example','http://localhost:5173.evil.example'])assert.equal((await req('/api/products',{headers:{Origin:origin}})).status,403);
   for(const path of ['/.env','/.git/config','/server/.env','/.security/database-admin.json','/%2eenv','/api/images/../../.env'])assert.notEqual((await req(path)).status,200,path);
   const h=await req('/api/health');assert.equal(h.headers.get('x-content-type-options'),'nosniff');assert.equal(h.headers.get('cache-control'),'no-store');assert.equal(h.headers.get('x-powered-by'),null);
   const huge=await req('/api/newsletter',{method:'POST',body:{email:'a'.repeat(1024*1024)}});assert.equal(huge.status,413);
  });
  await t.test('production TLS policy rejects driver option aliases and disabled verification',()=>{
   const baseEnv={JWT_SECRET:secret,NODE_ENV:'production',CLIENT_ORIGINS:'https://shop.example'};
   for(const suffix of ['tls=true&TLSALLOWINVALIDCERTIFICATES=true','tls=true&tlsAllowInvalidHostnames=TRUE','tls=true&tls=false','tls=true&sslValidate=false'])assert.throws(()=>validateConfiguration({...baseEnv,MONGODB_URI:'mongodb://app:password@db.example/mivorax?'+suffix}),suffix);
  });
  await t.test('forged proxy headers cannot evade login limits',async()=>{
   let r;for(let i=0;i<12;i++)r=await req('/api/admin/login',{method:'POST',body:{email:'probe-'+i+'@example.test',password:'incorrect'},headers:{'X-Forwarded-For':'198.51.100.'+i}});assert.equal(r.status,429);
  });
 }finally{
  if(server)await new Promise(r=>server.close(r));
  assert.equal(mongoose.connection.name,database);assert(database.startsWith('mivorax_pentest_'));
  await mongoose.connection.dropDatabase();await mongoose.disconnect();
 }
});
