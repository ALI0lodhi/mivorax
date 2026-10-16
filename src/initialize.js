import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {Product,Category,Collection,Post,Page,Site,Setting,Admin,resourceModels} from './models.js';
import {products,categories,posts} from './demo.js';
import {initialSite,initialPages} from './content.js';
import {defaultSettings} from './settings.js';
export async function seedDatabase({email,password,includeSamples=true}={}){
 for(const Model of [...Object.values(resourceModels),Site,Setting,Admin])await Model.init();
 if(includeSamples){for(const c of categories)await Category.updateOne({slug:c.slug},{$setOnInsert:c},{upsert:true});
 for(const p of products){const {_id,...data}=p;await Product.updateOne({slug:p.slug},{$setOnInsert:data},{upsert:true});}
 for(const p of posts){const {_id,...data}=p;await Post.updateOne({slug:p.slug},{$setOnInsert:data},{upsert:true});}}
 for(const page of initialPages)await Page.updateOne({slug:page.slug},{$setOnInsert:page},{upsert:true});
 await Setting.updateOne({key:'store'},{$setOnInsert:{value:defaultSettings}},{upsert:true});
 const hero=await Product.findOne({slug:'noir-essence'});
 const site=structuredClone(initialSite);if(hero)site.sections[0].productId=hero._id;
 await Site.updateOne({key:'website'},{$setOnInsert:site},{upsert:true,runValidators:true});
 const catalog=await Product.find({archivedAt:null}).select('_id');if(catalog.length)await Collection.updateOne({slug:'the-fragrance-edit'},{$setOnInsert:{name:'The fragrance edit',slug:'the-fragrance-edit',description:'Our introductory fragrance collection.',status:'published',productIds:catalog.map(p=>p._id),order:0}},{upsert:true,runValidators:true});
 if(email&&password){if(typeof password!=='string'||password.length<14||Buffer.byteLength(password)>72||password.includes('\0'))throw Error('Administrator password must have 14 or more characters and no more than 72 UTF-8 bytes.');await Admin.updateOne({email:email.toLowerCase()},{$setOnInsert:{passwordHash:await bcrypt.hash(password,12)}},{upsert:true});}
}

