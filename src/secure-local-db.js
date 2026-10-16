// One-time migration for this project's loopback-only replica set; never touches port 27017.
import {MongoClient} from 'mongodb';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const security=resolve(root,'.security');
const client=new MongoClient('mongodb://127.0.0.1:27018/?directConnection=true',{serverSelectionTimeoutMS:3000});
await client.connect();
const options=await client.db('admin').command({getCmdLineOpts:1});
if(resolve(options.parsed.storage.dbPath)!==resolve(root,'.local-db')||options.parsed.net.port!==27018||(options.parsed.replication.replSetName||options.parsed.replication.replSet)!=='mivorax-rs')throw Error('Refusing to change an unrelated MongoDB instance.');
if(options.parsed.security?.authorization==='enabled')throw Error('Database is already secured.');
mkdirSync(security,{recursive:true});
const credentialsPath=resolve(security,'database-admin.json');
if(existsSync(credentialsPath))throw Error('Existing credentials found; inspect the previous migration before retrying.');
const adminPassword=randomBytes(36).toString('base64url'),appPassword=randomBytes(36).toString('base64url');
const adminUri=`mongodb://mivorax_maintenance:${adminPassword}@127.0.0.1:27018/admin?replicaSet=mivorax-rs&authSource=admin`;
const appUri=`mongodb://mivorax_app:${appPassword}@127.0.0.1:27018/mivorax?replicaSet=mivorax-rs&authSource=mivorax`;
writeFileSync(credentialsPath,JSON.stringify({adminUri},null,2),{mode:0o600});
const keyPath=resolve(security,'replica.key');
writeFileSync(keyPath,randomBytes(512).toString('base64'),{mode:0o600});
await client.db('admin').command({createUser:'mivorax_maintenance',pwd:adminPassword,roles:[{role:'root',db:'admin'}]});
await client.db('mivorax').command({createUser:'mivorax_app',pwd:appPassword,roles:[{role:'readWrite',db:'mivorax'}]});
const envPath=resolve(root,'.env');
writeFileSync(envPath,readFileSync(envPath,'utf8').replace(/^MONGODB_URI=.*$/m,'MONGODB_URI='+appUri));
try{await client.db('admin').command({shutdown:1,force:false});}catch(e){if(!/closed|shutdown|network|ECONNRESET/i.test(e.message))throw e;}finally{await client.close();}
await new Promise(r=>setTimeout(r,1500));
const executable=options.argv[0];
const child=spawn(executable,['--dbpath',resolve(root,'.local-db'),'--port','27018','--bind_ip','127.0.0.1','--replSet','mivorax-rs','--auth','--keyFile',keyPath,'--logpath',resolve(root,'.local-db/mongod.log'),'--logappend'],{windowsHide:true,detached:true,stdio:'ignore'});
child.unref();
const secured=new MongoClient(appUri,{serverSelectionTimeoutMS:1000});
for(let attempt=0;attempt<30;attempt++){
 try{await secured.connect();await secured.db().command({ping:1});break;}
 catch{if(attempt===29)throw Error('Restart failed; credentials are preserved in server/.security.');await new Promise(r=>setTimeout(r,500));}
}
await secured.close();
console.log('Project database now requires authentication. App access is restricted to mivorax. Credentials were saved locally without printing them.');


