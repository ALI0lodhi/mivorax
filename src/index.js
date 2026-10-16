import mongoose from 'mongoose';
import {createApp} from './app.js';
import {validateConfiguration} from './security.js';
validateConfiguration();
mongoose.set('bufferCommands',false);
if(process.env.MONGODB_URI){
 try{await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000});await mongoose.connection.db.collection('login_attempts').createIndex({expiresAt:1},{expireAfterSeconds:0});await mongoose.connection.db.collection('rate_limits').createIndex({expiresAt:1},{expireAfterSeconds:0});console.log('MongoDB connected: '+mongoose.connection.name);}
 catch{throw Error('Database connection failed. Check the server configuration.');}
}else console.error('MONGODB_URI is missing. Configure server/.env; public content requires MongoDB.');
const server=createApp().listen(process.env.PORT||4000,process.env.HOST||'127.0.0.1',()=>console.log('MIVORAX API http://127.0.0.1:'+(process.env.PORT||4000)));
async function stop(){server.close();await mongoose.disconnect();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);

