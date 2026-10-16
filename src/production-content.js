import {initialPages} from './content.js';
export function normalizeText(value){
 if(typeof value==='string')return value.replace(/\s*\u2014\s*/g,' - ');
 if(Array.isArray(value))return value.map(normalizeText);
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizeText(item)]));
 return value;
}
export function cleanStoreDocument(collection,document){
 const next=normalizeText(document);
 if(collection==='sites'){
  next.tagline='';next.trustItems=[];next.footer.signoff='';
  if(/a little luxury|everyday feeling/i.test(next.footer.description||''))next.footer.description='';
  next.shop.eyebrow='';next.journal.eyebrow='';
  for(const section of next.sections){section.eyebrow='';if(section.type==='hero')section.caption='';if(['discovery','story'].includes(section.type))section.enabled=false;}
 }
 if(collection==='pages'){
  next.eyebrow='';
  const replacement=initialPages.find(page=>page.slug===next.slug);
  if(replacement&&/this development collection|development shipping amounts|policy approval pending|stored in MongoDB|this website is in development|approved support email|this collection is being prepared|sample products cannot be ordered/i.test(JSON.stringify(next)))Object.assign(next,{title:replacement.title,intro:replacement.intro,blocks:replacement.blocks});
 }
 return next;
}
