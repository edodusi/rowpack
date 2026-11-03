// Uses five functions out of lodash-es (640 modules): a tree-shaking test.
import { chunk, debounce, groupBy, kebabCase, uniqBy } from 'lodash-es';

const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i % 700, team: `Team ${i % 7}` }));
const unique = uniqBy(rows, 'id');
const byTeam = groupBy(unique, 'team');
const pages = chunk(unique, 50);
const slug = kebabCase('Your Bundle Is A Database');
const tick = debounce(() => {}, 10);
tick.cancel();

console.log('>', unique.length, Object.keys(byTeam).length, pages.length, slug);
if (typeof window !== 'undefined') window.__app = 'lodash-few';
