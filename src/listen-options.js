export function listenOptions(env=process.env){
 const value=env.PORT||'4000';
 if(!/^\d+$/.test(String(value))||!Number.isInteger(Number(value))||Number(value)<1||Number(value)>65535)throw Error('PORT must be an integer from 1 to 65535.');
 // Public production services must bind beyond loopback, even if a local
 // HOST value was accidentally copied into the hosting environment.
 return {port:Number(value),host:env.NODE_ENV==='production'?'0.0.0.0':env.HOST||'127.0.0.1'};
}
