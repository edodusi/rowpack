// All of date-fns and every locale: many small modules.
import * as dateFns from 'date-fns';
import * as locales from 'date-fns/locale';

const d = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
const fns = Object.keys(dateFns).filter((k) => typeof dateFns[k] === 'function');
console.log('>', fns.length, Object.keys(locales).length, dateFns.formatISO(d, { representation: 'date' }), dateFns.format(d, 'EEEE', { locale: locales.it }));
if (typeof window !== 'undefined') window.__app = 'date-fns-all';
