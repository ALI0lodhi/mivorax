import {MongoClient,BSON} from 'mongodb';
import dns from 'node:dns';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const collections=['settings','sites','products','categories','collections','pages','posts','admins','orders','reviews','coupons','audits','images.files','images.chunks'];
const sourceUri=process.env.MONGODB_URI,targetUri=process.env.MONGODB_TARGET_URI;
if(!sourceUri||!targetUri)throw Error('Set source MONGODB_URI and MONGODB_TARGET_URI privately.');
const sourceUrl=new URL(sourceUri),targetUrl=new URL(targetUri);
if(!['127.0.0.1','localhost'].includes(sourceUrl.hostname)||sourceUrl.pathname!=='/mivorax')throw Error('Source must be the local mivorax database.');
if(targetUrl.protocol!=='mongodb+srv:'||!targetUrl.hostname.endsWith('.mongodb.net')||targetUrl.pathname!=='/mivorax')throw Error('Target must be an Atlas SRV URI with explicit /mivorax database.');
const dnsOption=process.argv.find(arg=>arg.startsWith('--dns='));
if(dnsOption)dns.setServers(dnsOption.slice(6).split(','));
const source=new MongoClient(sourceUri,{serverSelectionTimeoutMS:15000}),target=new MongoClient(targetUri,{serverSelectionTimeoutMS:20000});
try{
 await source.connect();await target.connect();
 const from=source.db(),to=target.db();
 const documents={},indexes={};
 const read=source.startSession();
 try{await read.withTransaction(async()=>{for(const name of collections)documents[name]=await from.collection(name).find({},{session:read}).toArray();},{readConcern:{level:'snapshot'}});}finally{await read.endSession();}
 for(const name of collections){try{indexes[name]=await from.collection(name).listIndexes().toArray();}catch(e){if(e.code!==26)throw e;indexes[name]=[];}}
 if(!documents.settings.some(d=>d.key==='store')||!documents.sites.some(d=>d.key==='website')||!documents.admins.length)throw Error('Source lacks required store configuration or administrator.');
 const counts=Object.fromEntries(collections.map(name=>[name,documents[name].length]));
 for(const name of collections)if(await to.collection(name).countDocuments())throw Error('Target contains store data; refusing to overwrite: '+name);
 console.log(JSON.stringify({source:'local/mivorax',target:'Atlas/mivorax',counts,mode:process.argv.includes('--apply')?'apply':'dry-run'}));
 if(process.argv.includes('--apply')){
  const backup=resolve(dirname(fileURLToPath(import.meta.url)),'../.security','atlas-migration-'+new Date().toISOString().replace(/[:.]/g,'-'));
  mkdirSync(backup,{recursive:true});
  for(const name of collections)writeFileSync(resolve(backup,name+'.bson'),BSON.serialize({documents:documents[name]}),{mode:0o600});
  writeFileSync(resolve(backup,'manifest.json'),JSON.stringify({counts,createdAt:new Date().toISOString()},null,2),{mode:0o600});
  for(const name of collections){
   try{await to.createCollection(name);}catch(e){if(e.code!==48)throw e;}
   for(const index of indexes[name])if(index.name!=='_id_'){
    const options=Object.fromEntries(['name','unique','sparse','expireAfterSeconds','partialFilterExpression','collation'].filter(key=>index[key]!==undefined).map(key=>[key,index[key]]));
    await to.collection(name).createIndex(index.key,options);
   }
  }
  const session=target.startSession();
  try{await session.withTransaction(async()=>{
   for(const name of collections){if(await to.collection(name).countDocuments({},{session}))throw Error('Target changed during migration; refusing to overwrite.');if(documents[name].length)await to.collection(name).insertMany(documents[name],{session});}
  },{writeConcern:{w:'majority'},readConcern:{level:'snapshot'}});}finally{await session.endSession();}
  for(const name of collections){if(await to.collection(name).countDocuments()!==counts[name])throw Error('Count verification failed: '+name);}
  console.log('Migration committed and counts verified. Local data preserved; protected BSON backup saved under .security.');
 }else console.log('Dry run only. Add --apply to migrate to this empty target.');
}catch(e){console.error('Migration stopped:',['MongoServerSelectionError','MongoNetworkError','MongoParseError'].includes(e.name)?e.name:e.codeName||e.code||e.message);process.exitCode=1;}
finally{await source.close();await target.close();}
