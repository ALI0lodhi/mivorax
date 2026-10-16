import mongoose from 'mongoose';
import {seedDatabase} from './initialize.js';
if(!process.env.MONGODB_URI||!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)throw Error('Configure MONGODB_URI, ADMIN_EMAIL and ADMIN_PASSWORD in server/.env.');
await mongoose.connect(process.env.MONGODB_URI);
try{await seedDatabase({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD});console.log('MongoDB catalog, pages, website settings, collection and initial administrator initialized. Existing content preserved.');}finally{await mongoose.disconnect();}
