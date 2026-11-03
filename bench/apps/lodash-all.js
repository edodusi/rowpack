// Pulls in all of lodash-es (640 modules) through a namespace that escapes,
// so nothing can be shaken: a test of linking many modules at startup.
import * as _ from 'lodash-es';

const names = Object.keys(_).filter((k) => typeof _[k] === 'function');
console.log('>', names.length, _.sum(_.range(100)), _.camelCase('all of lodash'));
if (typeof window !== 'undefined') window.__app = 'lodash-all';
