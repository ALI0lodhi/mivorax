// A hidden, archived or coming-soon ancestor also hides its descendants' products.
export function visibleCategorySlugs(categories) {
  const map = new Map(categories.map(c => [c.slug, c]));
  function visible(c, seen = new Set()) {
    if (!c || c.archivedAt || c.status !== 'published' || seen.has(c.slug)) return false;
    if (!c.parent) return true;
    return visible(map.get(c.parent), new Set([...seen, c.slug]));
  }
  return categories.filter(c => visible(c)).map(c => c.slug);
}
export function visibleNavigationCategories(categories, products) {
  const published = new Set(visibleCategorySlugs(categories));
  const populated = new Set(products.map(p => p.category));
  const bySlug = new Map(categories.map(c => [c.slug, c]));
  function hasProducts(c) {
    return populated.has(c.slug) || categories.some(child => child.parent === c.slug && published.has(child.slug) && hasProducts(child));
  }
  return categories.filter(c => !c.archivedAt && (c.status === 'coming-soon'
    ? !c.parent || published.has(c.parent)
    : published.has(c.slug) && hasProducts(c))).sort((a, b) => a.order - b.order);
}
export function categoryTreeError(categories, current) {
  const map = new Map(categories.filter(c => !c.archivedAt).map(c => [c.slug, c]));
  map.set(current.slug, current);
  const seen = new Set([current.slug]);
  let parent = current.parent;
  while (parent) {
    if (seen.has(parent)) return 'A category cannot be its own ancestor.';
    const node = map.get(parent);
    if (!node) return 'Choose an existing, active parent category.';
    seen.add(parent); parent = node.parent;
  }
  return null;
}
