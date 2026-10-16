// Reject database operators and dangerous object keys before casting any input.
export function inputGuard(req,res,next) {
 const inspect=(value,depth=0)=>{
  if(depth>15)throw Error();
  if(typeof value==='string'&&(value.length>20000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))throw Error();
  if(Array.isArray(value)){if(value.length>1000)throw Error();value.forEach(v=>inspect(v,depth+1));}
  else if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){if(key.startsWith('$')||key.includes('.')||['__proto__','prototype','constructor'].includes(key))throw Error();inspect(v,depth+1);}
 };
 try{if(['POST','PUT','PATCH'].includes(req.method)&&req.is?.('application/json')&&req.body===undefined)throw Error();if(req.body!==undefined&&(!req.body||Array.isArray(req.body)||typeof req.body!=='object'))throw Error();inspect(req.body);inspect(req.query);next();}
 catch{res.status(400).json({error:'Invalid request data.'});}
}
export function validateConfiguration(env=process.env){
 if(!env.JWT_SECRET||env.JWT_SECRET.length<48||/replace|example|change-me|GENERATE_A|YOUR_SECRET/i.test(env.JWT_SECRET))throw Error('Configure a random JWT_SECRET of at least 48 characters.');
 if(!env.MONGODB_URI)throw Error('MONGODB_URI is required.');
 if(env.TRUST_PROXY_HOPS&&!/^[1-5]$/.test(env.TRUST_PROXY_HOPS))throw Error('TRUST_PROXY_HOPS must be an explicit hop count from 1 to 5.');
 const origins=(env.CLIENT_ORIGINS||'').split(',').filter(Boolean);
 for(const origin of origins){const url=new URL(origin);if(url.origin!==origin||url.username||url.password||!['http:','https:'].includes(url.protocol))throw Error('CLIENT_ORIGINS must contain exact HTTP(S) origins.');}
 if(env.NODE_ENV==='production'){
  if(!origins.length||origins.some(o=>!o.startsWith('https://')))throw Error('Production requires explicit HTTPS frontend origins.');
  const db=new URL(env.MONGODB_URI);
  if(!db.username||!db.password)throw Error('Production requires an authenticated database connection.');
  const parameters=new Map();
  for(const [key,value]of db.searchParams){const normalized=key.toLowerCase();if(parameters.has(normalized))throw Error('Duplicate database connection options are not allowed.');parameters.set(normalized,value.toLowerCase());}
  for(const name of ['tls','ssl'])if(parameters.has(name)&&parameters.get(name)!=='true')throw Error('Production database connections require TLS.');
  if(db.protocol!=='mongodb+srv:'&&parameters.get('tls')!=='true'&&parameters.get('ssl')!=='true')throw Error('Production database connections require TLS.');
  for(const key of ['tlsinsecure','tlsallowinvalidcertificates','tlsallowinvalidhostnames'])if(parameters.has(key)&&parameters.get(key)!=='false')throw Error('Database TLS verification must remain enabled.');
  if(parameters.has('sslvalidate')&&parameters.get('sslvalidate')!=='true')throw Error('Database TLS verification must remain enabled.');
  if(env.DEBUG||env.NODE_OPTIONS?.includes('--inspect'))throw Error('Debugging must be disabled in production.');
 }
}
