// Deleting a record also removes whatever pointed at it (menu links, collection entries, homepage
// sections, ...), so nobody has to untangle references by hand first.
import { Product, Category, Collection, Post, Page, Site, Review, Order } from './models.js';

const website = { key: 'website' };
// Editors that are open when we change the website design get the usual "changed in another session" warning.
const bump = { $inc: { __v: 1 } };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const removedFrom = (n, one, many) => 'removed from ' + plural(n, one, many);

function siteLinkCount(site, match) {
  const links = list => (list || []).filter(match).length;
  return links(site?.navigation) + (site?.footer?.groups || []).reduce((n, g) => n + links(g.links), 0) + links(site?.footer?.socialLinks);
}

// Each step knows how many records it touches (for the confirmation) and how to fix them.
async function referenceSteps(resource, doc) {
  const site = await Site.findOne(website).lean();
  const sections = site?.sections || [];
  const id = String(doc._id);

  if (resource === 'categories') {
    const slug = doc.slug;
    const parent = doc.parent ? await Category.findOne({ slug: doc.parent }).select('name slug').lean() : null;
    return [
      { count: await Category.countDocuments({ parent: slug }), text: n => plural(n, 'subcategory', 'subcategories') + ' will move up a level', run: () => Category.updateMany({ parent: slug }, { $set: { parent: doc.parent || '' }, ...bump }) },
      { count: await Product.countDocuments({ category: slug }),
        text: n => parent ? plural(n, 'product', 'products') + ' will move to “' + parent.name + '”' : plural(n, 'product', 'products') + ' will be archived (you can restore them later)',
        run: () => parent ? Product.updateMany({ category: slug }, { $set: { category: parent.slug }, ...bump }) : Product.updateMany({ category: slug, archivedAt: null }, { $set: { archivedAt: new Date() }, ...bump }) },
      { count: sections.filter(s => s.categorySlug === slug).length, text: n => removedFrom(n, 'homepage section', 'homepage sections'), run: () => Site.updateOne(website, { $set: { 'sections.$[s].categorySlug': '' }, ...bump }, { arrayFilters: [{ 's.categorySlug': slug }] }) },
      { count: siteLinkCount(site, l => l.category === slug), text: n => plural(n, 'menu link', 'menu links') + ' will be removed', run: () => Site.updateOne(website, { $pull: { navigation: { category: slug }, 'footer.groups.$[].links': { category: slug } }, ...bump }) },
    ];
  }

  if (resource === 'collections') {
    return [
      { count: sections.filter(s => s.collectionSlug === doc.slug).length, text: n => removedFrom(n, 'homepage section', 'homepage sections'), run: () => Site.updateOne(website, { $set: { 'sections.$[s].collectionSlug': '' }, ...bump }, { arrayFilters: [{ 's.collectionSlug': doc.slug }] }) },
    ];
  }

  if (resource === 'pages') {
    const hrefs = ['/pages/' + doc.slug, '/support/' + doc.slug, ...(doc.slug === 'about' ? ['/about'] : [])];
    return [
      { count: siteLinkCount(site, l => hrefs.includes(l.href)), text: n => plural(n, 'menu link', 'menu links') + ' will be removed', run: () => Site.updateOne(website, { $pull: { navigation: { href: { $in: hrefs } }, 'footer.groups.$[].links': { href: { $in: hrefs } }, 'footer.socialLinks': { href: { $in: hrefs } } }, ...bump }) },
    ];
  }

  if (resource === 'products') {
    return [
      { count: await Collection.countDocuments({ productIds: doc._id }), text: n => removedFrom(n, 'collection', 'collections'), run: () => Collection.updateMany({ productIds: doc._id }, { $pull: { productIds: doc._id }, ...bump }) },
      { count: await Post.countDocuments({ productIds: doc._id }), text: n => removedFrom(n, 'journal post', 'journal posts'), run: () => Post.updateMany({ productIds: doc._id }, { $pull: { productIds: doc._id }, ...bump }) },
      { count: sections.filter(s => String(s.productId) === id).length, text: n => removedFrom(n, 'homepage section', 'homepage sections'), run: () => Site.updateOne(website, { $set: { 'sections.$[s].productId': null }, ...bump }, { arrayFilters: [{ 's.productId': doc._id }] }) },
      { count: await Review.countDocuments({ productId: doc._id }), text: n => plural(n, 'review', 'reviews') + ' of this product will be deleted', run: () => Review.deleteMany({ productId: doc._id }) },
      { count: await Order.countDocuments({ 'items.productId': id }), info: true, text: n => plural(n, 'past order keeps', 'past orders keep') + ' its own copy of the product details, so order history is not affected.', run: async () => {} },
    ];
  }

  if (resource === 'images') {
    const ref = '/api/images/' + id;
    const slides = sections.reduce((n, s) => n + (s.slides || []).filter(sl => sl.desktopImage === ref || sl.mobileImage === ref).length, 0);
    const onSite = (site?.logo === ref ? 1 : 0) + sections.filter(s => s.image === ref).length + slides;
    return [
      { count: await Product.countDocuments({ images: ref }), text: n => removedFrom(n, 'product', 'products'), run: () => Product.updateMany({ images: ref }, { $pull: { images: ref }, ...bump }) },
      { count: await Category.countDocuments({ image: ref }), text: n => removedFrom(n, 'category', 'categories'), run: () => Category.updateMany({ image: ref }, { $set: { image: '' }, ...bump }) },
      { count: await Collection.countDocuments({ image: ref }), text: n => removedFrom(n, 'collection', 'collections'), run: () => Collection.updateMany({ image: ref }, { $set: { image: '' }, ...bump }) },
      { count: await Post.countDocuments({ coverImage: ref }), text: n => removedFrom(n, 'journal post', 'journal posts'), run: () => Post.updateMany({ coverImage: ref }, { $set: { coverImage: '' }, ...bump }) },
      { count: await Page.countDocuments({ image: ref }), text: n => removedFrom(n, 'page', 'pages'), run: () => Page.updateMany({ image: ref }, { $set: { image: '' }, ...bump }) },
      { count: onSite, text: n => removedFrom(n, 'place on the website', 'places on the website'), run: async () => {
        await Site.updateOne({ ...website, logo: ref }, { $set: { logo: '' } });
        await Site.updateOne(website, { $set: { 'sections.$[s].image': '' } }, { arrayFilters: [{ 's.image': ref }] });
        await Site.updateOne(website, { $set: { 'sections.$[].slides.$[sl].desktopImage': '' } }, { arrayFilters: [{ 'sl.desktopImage': ref }] });
        await Site.updateOne(website, { $set: { 'sections.$[].slides.$[sl].mobileImage': '' } }, { arrayFilters: [{ 'sl.mobileImage': ref }] });
        await Site.updateOne(website, bump);
      } },
    ];
  }

  return [];
}

const summarise = steps => {
  const lines = [], notes = [];
  for (const step of steps) if (step.count > 0) (step.info ? notes : lines).push(step.text(step.count));
  return { lines, notes };
};

// What deleting this record would also change, in plain words (shown before the manager confirms).
export async function deleteImpact(resource, doc) {
  return summarise(await referenceSteps(resource, doc));
}

// Run after the record itself is gone. Returns what was changed.
export async function cleanUpReferences(resource, doc) {
  const steps = await referenceSteps(resource, doc);
  for (const step of steps) if (step.count > 0 && !step.info) await step.run();
  return summarise(steps);
}
