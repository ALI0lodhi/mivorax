import {MongoClient,BSON} from 'mongodb';
import dns from 'node:dns';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanStoreDocument} from './production-content.js';
const collections=['sites','pages','products','categories','collections','posts'];
const targets=[['local',process.env.MONGODB_URI],['Atlas',process.env.MONGODB_TARGET_URI]].filter(([,uri])=>uri);
const dnsOption=process.argv.find(arg=>arg.startsWith('--dns='));if(dnsOption)dns.setServers(dnsOption.slice(6).split(','));
for(const [label,uri]of targets){
 const url=new URL(uri);if(url.pathname!=='/mivorax')throw Error('Refusing an unexpected database name.');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:15000});
 try{
  await client.connect();const db=client.db(),changes=[];
  for(const collection of collections)for(const document of await db.collection(collection).find({}).toArray()){
   const next=cleanStoreDocument(collection,document);
   if(BSON.EJSON.stringify(next)!==BSON.EJSON.stringify(document))changes.push({collection,document,next});
  }
  console.log(JSON.stringify({target:label,changes:changes.map(change=>({collection:change.collection,record:String(change.document._id)})),apply:process.argv.includes('--apply')}));
  if(process.argv.includes('--apply')&&changes.length){
   const backup=resolve(dirname(fileURLToPath(import.meta.url)),'../.security','storefront-cleanup-'+label+'-'+Date.now());mkdirSync(backup,{recursive:true});
   writeFileSync(resolve(backup,'before.bson'),BSON.serialize({changes:changes.map(({collection,document})=>({collection,document}))}),{mode:0o600});
   const session=client.startSession();try{await session.withTransaction(async()=>{
    for(const {collection,document,next}of changes){const {_id,__v,...fields}=next;const result=await db.collection(collection).updateOne({_id:document._id,__v:document.__v===undefined?{$exists:false}:document.__v},{$set:{...fields,updatedAt:new Date()},$inc:{__v:1}},{session});if(!result.modifiedCount)throw Error('A record changed. Retry after refreshing your admin session.');}
   },{writeConcern:{w:'majority'}});}finally{await session.endSession();}
   console.log(label+': cleanup saved; prior content backed up privately. Checkout settings unchanged.');
  }
  const settings=await db.collection('settings').findOne({key:'store'});console.log(JSON.stringify({target:label,checkoutEnabled:settings?.value?.checkoutEnabled,supportEmailConfigured:!!settings?.value?.supportEmail,deliveryInformationConfigured:!!settings?.value?.deliveryEstimate}));
 }catch(error){console.error(label+': cleanup could not complete ('+(error.codeName||error.code||error.name)+').');process.exitCode=1;}finally{await client.close();}
}
