import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const options={timestamps:true,strict:'throw'};
const text=(required=false,maxlength=4000)=>({type:String,trim:true,required,maxlength});
const slug={...text(true,100),match:/^[a-z0-9]+(?:-[a-z0-9]+)*$/,unique:true};
const money={type:Number,min:0,max:100000000,validate:Number.isFinite};
const integer={type:Number,min:0,max:1000000,validate:Number.isInteger};
export const safeLink=v=>{
 if(!v)return true;
 if(typeof v!=='string'||/[\s\\\u0000-\u001f\u007f]/.test(v)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(v))return false;
 try{const parsed=new URL(v,'https://mivorax.invalid');if(parsed.username||parsed.password)return false;if(v.startsWith('/'))return !v.startsWith('//')&&parsed.origin==='https://mivorax.invalid';return ['https:','mailto:','tel:'].includes(parsed.protocol);}catch{return false;}
};
const url={...text(false,1000),validate:{validator:safeLink,message:'Use a relative URL or HTTPS, mailto or tel URL.'}};
const image={...text(false,1000),validate:{validator:v=>!v||/^\/api\/images\/[a-f0-9]{24}$/.test(v)||(v.startsWith('https://')&&safeLink(v)),message:'Use a library image or HTTPS URL.'}};
const archivedAt={type:Date,default:null};
const block=new Schema({heading:text(false,300),text:text(false,20000)},{_id:false});
const slide=new Schema({desktopImage:image,mobileImage:image,title:text(false,300),body:text(false,2000),buttonLabel:text(false,150),buttonUrl:url},{_id:false});
const link=new Schema({label:text(true,100),href:{...url,required:true},enabled:{type:Boolean,default:true},category:text(false,100)},{_id:false});
export const Product=model('Product',new Schema({
 slug,name:text(true,200),subtitle:text(false,500),description:text(false,20000),category:text(true,100),
 family:text(false,100),audience:text(false,100),price:{...money,required:true},salePrice:money,volume:text(false,100),type:text(false,100),notes:[text(false,100)],
 color:{type:String,match:/^#[0-9a-f]{6}$/i,default:'#34271f'},accent:{type:String,match:/^#[0-9a-f]{6}$/i,default:'#a7834d'},
 stock:{...integer,default:0},status:{type:String,enum:['draft','published'],default:'draft'},images:[image],imageAlt:text(false,500),
 care:text(false,4000),details:text(false,10000),shippingSummary:text(false,4000),featured:Boolean,bestseller:Boolean,newArrival:Boolean,
 seoTitle:text(false,200),metaDescription:text(false,500),archivedAt
},options));
export const Category=model('Category',new Schema({name:text(true,100),slug,description:text(false,4000),image,parent:{type:String,default:''},order:{...integer,default:0},status:{type:String,enum:['hidden','published','coming-soon'],default:'hidden'},showOnHomepage:{type:Boolean,default:false},seoTitle:text(false,200),metaDescription:text(false,500),archivedAt},options));
export const Collection=model('Collection',new Schema({name:text(true,150),slug,description:text(false,4000),image,productIds:[{type:Schema.Types.ObjectId,ref:'Product'}],status:{type:String,enum:['draft','published'],default:'draft'},order:{...integer,default:0},archivedAt},options));
export const Setting=model('Setting',new Schema({key:{type:String,unique:true},value:Schema.Types.Mixed},options));
export const Post=model('Post',new Schema({slug,title:text(true,300),category:text(false,100),excerpt:text(false,2000),readTime:{...integer,default:3},publishedAt:{type:Date,required:true},author:text(false,150),tone:{type:String,enum:['amber','rose'],default:'amber'},coverImage:image,coverAlt:text(false,500),body:[block],productIds:[{type:Schema.Types.ObjectId,ref:'Product'}],status:{type:String,enum:['draft','published','archived'],default:'draft'},seoTitle:text(false,200),metaDescription:text(false,500),archivedAt},options));
export const Page=model('Page',new Schema({slug,title:text(true,300),eyebrow:text(false,150),intro:text(false,4000),image,blocks:[block],status:{type:String,enum:['draft','published'],default:'draft'},seoTitle:text(false,200),metaDescription:text(false,500),archivedAt},options));
const section=new Schema({key:{...text(true,100),match:/^[a-z0-9-]+$/},type:{type:String,enum:['hero','products','discovery','story','journal','newsletter','collections','reviews'],required:true},enabled:{type:Boolean,default:true},order:{...integer,default:0},eyebrow:text(false,200),title:text(false,500),emphasis:text(false,300),body:text(false,4000),buttonLabel:text(false,150),buttonUrl:url,image,imageAlt:text(false,500),caption:text(false,500),productId:{type:Schema.Types.ObjectId,ref:'Product',default:null},collectionSlug:text(false,100),categorySlug:text(false,100),productFilter:{type:String,enum:['tabs','featured','new','best'],default:'tabs'},slides:[slide]},{_id:false});
export const Site=model('Site',new Schema({key:{type:String,unique:true,default:'website'},name:text(true,100),tagline:text(false,200),logo:image,logoAlt:text(false,200),
 announcement:{enabled:Boolean,lines:[text(false,200)],label:text(false,150),href:url},
 theme:{wine:{type:String,match:/^#[a-f0-9]{6}$/i},background:{type:String,match:/^#[a-f0-9]{6}$/i},text:{type:String,match:/^#[a-f0-9]{6}$/i}},
 navigation:[link],showCategories:{type:Boolean,default:true},
 footer:{description:text(false,1000),signoff:text(false,500),copyright:text(false,300),groups:[{_id:false,title:text(true,100),links:[link]}],socialLinks:[link]},
 sections:[section],trustItems:[text(false,200)],shop:{eyebrow:text(false,150),title:text(false,300),description:text(false,1000)},journal:{eyebrow:text(false,150),title:text(false,300),description:text(false,1000)},seoTitle:text(false,200),metaDescription:text(false,500)
},options));
export const Review=model('Review',new Schema({productId:{type:Schema.Types.ObjectId,ref:'Product',required:true},orderReference:text(true,100),author:text(true,100),rating:{type:Number,min:1,max:5,required:true,validate:Number.isInteger},text:text(true,4000),status:{type:String,enum:['draft','published'],default:'draft'},archivedAt},options));
export const Admin=model('Admin',new Schema({email:{...text(true,254),unique:true,lowercase:true},passwordHash:{type:String,required:true,select:false},disabled:{type:Boolean,default:false},passwordChangedAt:Date},options));
export const Order=model('Order',new Schema({reference:{type:String,unique:true},idempotencyHash:{type:String,unique:true,sparse:true,select:false},requestHash:{type:String,select:false},trackingHash:{type:String,select:false},customer:{name:String,email:String,phone:String,address:String,city:String,country:String},items:[{productId:String,name:String,quantity:Number,unitPrice:Number,volume:String}],subtotal:Number,shipping:Number,discount:Number,total:Number,paymentMethod:String,coupon:String,status:{type:String,default:'confirmed',enum:['confirmed','processing','shipped','delivered','cancelled']},trackingNumber:text(false,200),courier:text(false,200),adminNote:text(false,4000),cancelledAt:Date},options));
export const Subscriber=model('Subscriber',new Schema({email:{type:String,unique:true},consentedAt:Date,source:String,active:{type:Boolean,default:true}},options));
export const Coupon=model('Coupon',new Schema({code:{...text(true,80),unique:true,uppercase:true,match:/^[A-Z0-9-]+$/},kind:{type:String,enum:['percentage','fixed'],required:true},amount:{...money,required:true},minOrder:{...money,default:0},startsAt:Date,expiresAt:Date,usageLimit:{...integer,default:0},used:{...integer,default:0},enabled:{type:Boolean,default:false},archivedAt},options));
export const Audit=model('Audit',new Schema({admin:String,action:String,detail:String},options));
export const resourceModels={products:Product,categories:Category,collections:Collection,posts:Post,pages:Page,coupons:Coupon,reviews:Review};
export const resourceFields=Object.fromEntries(Object.entries(resourceModels).map(([k,M])=>[k,Object.keys(M.schema.paths).filter(p=>!['_id','__v','createdAt','updatedAt','archivedAt','used'].includes(p)&&!p.includes('.'))]));


export const AdminSession=model('AdminSession',new Schema({tokenHash:{type:String,unique:true,required:true},admin:{type:Schema.Types.ObjectId,ref:'Admin',required:true},expiresAt:{type:Date,required:true,index:{expires:0}}},options));
