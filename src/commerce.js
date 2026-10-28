export function calculateTotals(items, settings, coupon=null) {
 const subtotal=items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0);
 const shipping=subtotal>=settings.freeShippingThreshold?0:settings.shippingFee;
 const discount=coupon?Math.min(subtotal,Math.round(coupon.kind==='percentage'?subtotal*coupon.amount/100:coupon.amount)):0;
 return {subtotal,shipping,discount,total:subtotal+shipping-discount};
}
// Size-aware pricing/stock. A product with a non-empty `sizes` array is priced and stocked
// per size; otherwise it uses the product-level price/salePrice and stock.
export const productHasSizes=p=>Array.isArray(p?.sizes)&&p.sizes.length>0;
export const findSize=(p,size)=>productHasSizes(p)?(p.sizes.find(s=>s.label===size)||null):null;
export function linePrice(p,size){ if(productHasSizes(p)){ const s=findSize(p,size); return s?s.price:null; } return p.salePrice??p.price; }
export function lineStock(p,size){ if(productHasSizes(p)){ const s=findSize(p,size); return s?s.stock:null; } return p.stock; }
export function couponIsValid(coupon,subtotal,now=new Date()) {
 return !!coupon && coupon.enabled && subtotal>=coupon.minOrder && (!coupon.startsAt||new Date(coupon.startsAt)<=now) && (!coupon.expiresAt||new Date(coupon.expiresAt)>now) && (!coupon.usageLimit||coupon.used<coupon.usageLimit);
}
export function validateCheckout(body,settings) {
 if(!settings.checkoutEnabled) return 'Checkout is not open yet.';
 if(body.coupon!==undefined&&(typeof body.coupon!=='string'||body.coupon.length>80))return 'Invalid discount code.';
 if(body.paymentMethod==='cod'){if(!settings.codEnabled) return 'This payment method is unavailable.';}
 else if(body.paymentMethod==='safepay'){if(!settings.prepaidEnabled) return 'This payment method is unavailable.';}
 else return 'This payment method is unavailable.';
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>30) return 'Your bag must contain 1–30 items.';
 if(body.items.some(i=>!i||typeof i.productId!=='string'||!i.productId||(i.size!==undefined&&(typeof i.size!=='string'||i.size.length>100))||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>10)) return 'Invalid item quantity.';
 if(new Set(body.items.map(i=>i.productId+'\u0000'+(i.size||''))).size!==body.items.length) return 'Duplicate items are not allowed.';
 const c=body.customer;
 if(!c||['name','email','phone','address','city'].some(k=>typeof c[k]!=='string'||!c[k].trim()||c[k].length>300)) return 'Complete all delivery details.';
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return 'Enter a valid email address.';
 if(c.country!==settings.country) return 'This country is not supported.';
 return null;
}
