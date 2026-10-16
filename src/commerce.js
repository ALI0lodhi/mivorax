export function calculateTotals(items, settings, coupon=null) {
 const subtotal=items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0);
 const shipping=subtotal>=settings.freeShippingThreshold?0:settings.shippingFee;
 const discount=coupon?Math.min(subtotal,Math.round(coupon.kind==='percentage'?subtotal*coupon.amount/100:coupon.amount)):0;
 return {subtotal,shipping,discount,total:subtotal+shipping-discount};
}
export function couponIsValid(coupon,subtotal,now=new Date()) {
 return !!coupon && coupon.enabled && subtotal>=coupon.minOrder && (!coupon.startsAt||new Date(coupon.startsAt)<=now) && (!coupon.expiresAt||new Date(coupon.expiresAt)>now) && (!coupon.usageLimit||coupon.used<coupon.usageLimit);
}
export function validateCheckout(body,settings) {
 if(!settings.checkoutEnabled) return 'Checkout is not open yet.';
 if(body.coupon!==undefined&&(typeof body.coupon!=='string'||body.coupon.length>80))return 'Invalid discount code.';
 if(body.paymentMethod!=='cod'||!settings.codEnabled) return 'This payment method is unavailable.';
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>30) return 'Your bag must contain 1–30 items.';
 if(body.items.some(i=>!i||typeof i.productId!=='string'||!i.productId||!Number.isInteger(i.quantity)||i.quantity<1||i.quantity>10)) return 'Invalid item quantity.';
 if(new Set(body.items.map(i=>i.productId)).size!==body.items.length) return 'Duplicate items are not allowed.';
 const c=body.customer;
 if(!c||['name','email','phone','address','city'].some(k=>typeof c[k]!=='string'||!c[k].trim()||c[k].length>300)) return 'Complete all delivery details.';
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return 'Enter a valid email address.';
 if(c.country!==settings.country) return 'This country is not supported.';
 return null;
}
