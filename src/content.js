// Only the seed command imports these defaults. Public routes read MongoDB.
export const initialSite = {
  key: 'website', name: 'MIVORAX', tagline: 'LUXURY WITHIN REACH', logo: '', logoAlt: 'MIVORAX',
  announcement: { enabled: true, lines: ['A little luxury. An everyday feeling.'], label: 'Discover the fragrance edit', href: '/shop' },
  theme: { wine: '#491e2c', background: '#fdfbf7', text: '#292723' }, showCategories: true,
  navigation: [{ label: 'Shop all', href: '/shop', enabled: true }, { label: 'The Journal', href: '/journal', enabled: true }, { label: 'Our story', href: '/about', enabled: true }],
  footer: { description: 'A little luxury.\nAn everyday feeling.', signoff: 'Make room for the little luxuries.', copyright: 'All rights reserved.',
    groups: [{ title: 'EXPLORE', links: [{ label: 'The collection', href: '/shop' }, { label: 'The Journal', href: '/journal' }, { label: 'Our story', href: '/about' }] },
      { title: 'HERE TO HELP', links: [{ label: 'Contact us', href: '/support/contact' }, { label: 'Frequently asked', href: '/support/faq' }, { label: 'Shipping & delivery', href: '/support/shipping' }, { label: 'Returns & refunds', href: '/support/returns' }, { label: 'Privacy policy', href: '/support/privacy' }, { label: 'Terms & conditions', href: '/support/terms' }] }], socialLinks: [] },
  trustItems: ['Thoughtfully presented', 'Pakistan, to your doorstep', 'A considered shopping experience'],
  shop: { eyebrow: 'A PERSONAL SIGNATURE', title: 'The fragrance collection.', description: 'Find a little of yourself in every note.' },
  journal: { eyebrow: 'THE MIVORAX JOURNAL', title: 'Stories worth a moment.', description: 'Notes on fragrance, thoughtful gifting, and the everyday.' },
  seoTitle: 'MIVORAX - Luxury Within Reach', metaDescription: 'Discover MIVORAX. A considered collection of fragrances. Luxury Within Reach.',
  sections: [
    { key: 'hero', type: 'hero', enabled: true, order: 0, eyebrow: 'THE MIVORAX FRAGRANCE EDIT', title: 'Leave a little', emphasis: 'of yourself.', body: 'For the moments that become memories.\nDiscover a scent that feels unmistakably you.', buttonLabel: 'Find your signature', buttonUrl: '/shop', caption: 'CONSIDERED SCENTS. EVERYDAY LUXURY.' },
    { key: 'featured', type: 'products', enabled: true, order: 1, eyebrow: 'THE EVERYDAY, ELEVATED', title: 'Find your new favourite.', buttonLabel: 'Explore all fragrances', buttonUrl: '/shop' },
    { key: 'discovery', type: 'discovery', enabled: true, order: 2, eyebrow: 'YOUR SCENT, YOUR STORY', title: 'Good taste.', emphasis: 'More personal.', body: 'Fresh and effortless. Warm and intriguing. Soft and understated. Explore the notes that speak your language.', caption: 'A NOTE.\nA FEELING.\nA memory.' },
    { key: 'philosophy', type: 'story', enabled: true, order: 3, eyebrow: 'THE MIVORAX PHILOSOPHY', title: 'Luxury is a feeling.', emphasis: 'It should feel within reach.', body: 'Considered details. An uncluttered approach.\nA little more intention in the everyday.', buttonLabel: 'Meet MIVORAX', buttonUrl: '/about' },
    { key: 'journal', type: 'journal', enabled: true, order: 4, eyebrow: 'NOTES FROM MIVORAX', title: 'A little inspiration.', buttonLabel: 'Inside the Journal', buttonUrl: '/journal' },
    { key: 'newsletter', type: 'newsletter', enabled: true, order: 5, eyebrow: 'A NOTE, NOW AND THEN', title: 'Good things. In your inbox.', body: 'Collection notes, new arrivals, and a little inspiration.' },
  ],
};
export const initialPages = [
 {slug:'about',title:'About MIVORAX',intro:'Explore the MIVORAX fragrance collection.',blocks:[{heading:'Our fragrances',text:'Browse the collection to find fragrance notes, sizes, prices and availability. Visit each product page for its details and care information.'}]},
 {slug:'shipping',title:'Shipping & delivery',intro:'Shipping charges are shown at checkout.',blocks:[{heading:'Delivery information',text:'Enter your delivery address at checkout and review the shipping charge before placing your order. For delivery questions, contact MIVORAX using the details on our Contact page.'}]},
 {slug:'returns',title:'Returns & refunds',intro:'Contact MIVORAX for help with a return, damaged item or refund enquiry.',blocks:[{heading:'Request assistance',text:'Provide your order reference and a description of the issue when contacting customer support. Contact us before sending an item back.'}]},
 {slug:'privacy',title:'Privacy policy',intro:'We use the information you provide to process orders and respond to your enquiries.',blocks:[{heading:'Order information',text:'Checkout asks for your name, email address, phone number and delivery address. We use these details to handle your order and arrange delivery.'},{heading:'Newsletter',text:'Newsletter registration requires your separate consent to receive marketing emails.'},{heading:'Your order access key',text:'Keep your private tracking key secure. Contact customer support with questions about your information.'}]},
 {slug:'terms',title:'Terms & conditions',intro:'Review product details, pricing and delivery information before placing an order.',blocks:[{heading:'Shopping with MIVORAX',text:'The product page shows the price, size and availability of each item. Checkout shows shipping charges, applicable discounts and your order total.'},{heading:'Order enquiries',text:'Save your order reference and private tracking key after checkout. Contact customer support if you need help with your order.'}]},
 {slug:'contact',title:'Contact MIVORAX',intro:'Get in touch for product information and order assistance.',blocks:[]},
 {slug:'coming-soon',title:'Coming soon',intro:'This collection is not available yet.',blocks:[]},
 {slug:'faq',title:'Frequently asked questions',intro:'Help with shopping and orders.',blocks:[{heading:'How do I place an order?',text:'Choose a product, add it to your bag and continue to checkout. Available payment methods and the final total are shown before you place an order.'},{heading:'Where do you deliver?',text:'Available delivery information is shown at checkout. Contact customer support for help with your location.'},{heading:'How can I track my order?',text:'Contact customer support with your order reference for an update on your delivery.'},{heading:'How do I request a return?',text:'Contact customer support with your order reference and details of the issue. Review the Returns & refunds page for guidance.'}]}
].map(page=>({...page,status:'published',eyebrow:''}));
// New installations start without decorative promotional sections or taglines.
initialSite.tagline='';initialSite.trustItems=[];initialSite.footer.signoff='';initialSite.footer.description='';
initialSite.shop.eyebrow='';initialSite.journal.eyebrow='';
for(const section of initialSite.sections){section.eyebrow='';if(section.type==='hero')section.caption='';if(['discovery','story'].includes(section.type))section.enabled=false;}
