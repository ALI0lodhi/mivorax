import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const port = Number(process.env.LOCAL_MONGODB_PORT || 27018);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(root, '.local-db');
const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
const keyPath=resolve(root,'.security/replica.key');
let child;
const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 });
try { await probe.connect(); }
catch {
  const base = 'C:/Program Files/MongoDB/Server';
  const installed = existsSync(base) ? readdirSync(base).sort().reverse().map(v => resolve(base, v, 'bin/mongod.exe')).find(existsSync) : null;
  const executable = process.env.MONGOD_PATH || installed;
  if (!executable) throw Error('MongoDB Server was not found. Install it or set MONGOD_PATH to its executable.');
  mkdirSync(dbPath, { recursive: true });
  child = spawn(executable, [...(existsSync(keyPath)?['--auth','--keyFile',keyPath]:[]),'--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--replSet', 'mivorax-rs', '--logpath', resolve(dbPath, 'mongod.log'), '--logappend'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await probe.connect(); connected = true; break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!connected) { child.kill(); throw Error('Local database did not start. Inspect server/.local-db/mongod.log.'); }
}
const hello = await probe.db('admin').command({ hello: 1 });
if (hello.setName && hello.setName !== 'mivorax-rs') throw Error('Port is used by a different replica set. No changes made.');
if (!hello.setName) {
  try { await probe.db('admin').command({ replSetInitiate: { _id: 'mivorax-rs', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } }); }
  catch (e) { if (e.codeName !== 'AlreadyInitialized') throw e; }
}
for (let attempt = 0; attempt < 40; attempt++) {
  const state = await probe.db('admin').command({ hello: 1 });
  if (state.isWritablePrimary) break;
  if (attempt === 39) throw Error('Replica set did not elect a primary.');
  await new Promise(r => setTimeout(r, 500));
}
await probe.close();
console.log('Local MIVORAX MongoDB is ready. Use MONGODB_URI from server/.env in Compass.');
console.log('Data persists in server/.local-db. Stop this command to stop the instance it started.');
if (child) {
  child.on('exit', code => { process.exitCode = code || 0; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(); });
} else console.log('Reused the already-running MIVORAX instance.');
