import mongoose from 'mongoose';
import crypto from 'node:crypto';
// Shared across API processes and restarts; no IP addresses stored in plaintext.
export class MongoRateStore {
 constructor(prefix){this.prefix=prefix;this.localKeys=false;}
 init(options){this.windowMs=options.windowMs;}
 identity(key){return this.prefix+':'+Math.floor(Date.now()/this.windowMs)+':'+crypto.createHash('sha256').update(key).digest('hex');}
 collection(){if(mongoose.connection.readyState!==1)throw Object.assign(Error('Service temporarily unavailable.'),{status:503});return mongoose.connection.db.collection('rate_limits');}
 async increment(key){const expiresAt=new Date((Math.floor(Date.now()/this.windowMs)+1)*this.windowMs);const row=await this.collection().findOneAndUpdate({_id:this.identity(key)},{$inc:{hits:1},$set:{expiresAt}},{upsert:true,returnDocument:'after'});return {totalHits:row.hits,resetTime:row.expiresAt};}
 async decrement(key){await this.collection().updateOne({_id:this.identity(key),hits:{$gt:0}},{$inc:{hits:-1}});}
 async resetKey(key){await this.collection().deleteOne({_id:this.identity(key)});}
}
