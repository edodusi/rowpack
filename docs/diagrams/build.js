#!/usr/bin/env node
/**
 * Architecture diagrams drawn with the official AWS Architecture Icons
 * (https://aws.amazon.com/architecture/icons/). The icon package is not in
 * this repo: download it, unzip it, and pass the folder.
 *
 *   node docs/diagrams/build.js <unzipped icon package> [--png]
 *
 * Icons are embedded unmodified (no recolouring, no cropping), labelled with
 * the service name, as the icon guidelines ask.
 */
import fs from 'node:fs';
import path from 'node:path';

const [iconRoot] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!iconRoot) throw new Error('usage: build.js <icon package folder> [--png]');
const find = (name) => {
  const hit = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__MACOSX') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) hit.push(p);
    }
  };
  walk(iconRoot);
  if (!hit.length) throw new Error(`icon ${name} not found`);
  return `data:image/svg+xml;base64,${fs.readFileSync(hit[0]).toString('base64')}`;
};

const icons = {
  client: find('Res_Client_48_Light.svg'),
  cloudfront: find('Arch_Amazon-CloudFront_48.svg'),
  lambda: find('Arch_AWS-Lambda_48.svg'),
  fn: find('Res_AWS-Lambda_Lambda-Function_48.svg'),
  s3: find('Arch_Amazon-Simple-Storage-Service_48.svg'),
  object: find('Res_Amazon-Simple-Storage-Service_Object_48.svg'),
  cloud: find('AWS-Cloud-logo_32.svg'),
  region: find('Region_32.svg'),
  laptop: find('Res_Client_48_Light.svg'),
};

const FONT = "font-family='Helvetica, Arial, sans-serif'";
const text = (x, y, s, { size = 13, weight = 400, anchor = 'middle', fill = '#232F3E' } = {}) =>
  s.split('\n').map((line, i) => `<text x='${x}' y='${y + i * (size + 3)}' ${FONT} font-size='${size}' font-weight='${weight}' text-anchor='${anchor}' fill='${fill}'>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`).join('');
const icon = (x, y, href, label, size = 56) => `<image x='${x - size / 2}' y='${y - size / 2}' width='${size}' height='${size}' href='${href}'/>${text(x, y + size / 2 + 18, label, { size: 12.5 })}`;
const arrow = (pts, label, { lx, ly, dashed = false, anchor = 'middle' } = {}) => {
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  return `<path d='${d}' fill='none' stroke='#545B64' stroke-width='1.6' ${dashed ? "stroke-dasharray='5 4'" : ''} marker-end='url(#a)'/>` +
    (label ? text(lx, ly, label, { size: 11.5, fill: '#16191F', anchor }) : '');
};
const step = (x, y, n) => `<circle cx='${x}' cy='${y}' r='10' fill='#232F3E'/>${text(x, y + 4.5, String(n), { size: 12, weight: 700, fill: '#FFFFFF' })}`;
const group = (x, y, w, h, href, label, color) =>
  `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='none' stroke='${color}' stroke-width='1.2' ${color === '#00A4A6' ? "stroke-dasharray='6 4'" : ''}/>` +
  `<image x='${x}' y='${y}' width='32' height='32' href='${href}'/>${text(x + 40, y + 21, label, { size: 12.5, anchor: 'start', weight: 600 })}`;
const svg = (w, h, body) => `<?xml version='1.0' encoding='UTF-8'?>
<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>
<defs><marker id='a' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill='#545B64'/></marker></defs>
<rect width='100%' height='100%' fill='#FFFFFF'/>
${body}
</svg>
`;

// ---- rowpack-serve ------------------------------------------------------------
// CloudFront is global, so it sits in the AWS Cloud group but outside the Region.
const legend = [
  'First visit: no JavaScript yet',
  'Hash each module source',
  'Compile what S3 lacks',
  'Link with SQL, upload',
  'Later visits: CloudFront',
];
const serve = svg(1100, 650, [
  group(170, 40, 910, 530, icons.cloud, 'AWS Cloud', '#232F3E'),
  group(430, 90, 630, 460, icons.region, 'eu-west-1', '#00A4A6'),
  icon(80, 300, icons.client, 'Browser'),
  icon(300, 300, icons.cloudfront, 'Amazon CloudFront\n(origin access control)'),
  icon(570, 200, icons.lambda, 'Lambda Web Function\nrowpack-serve\n(IamAuth endpoint)'),
  icon(930, 200, icons.fn, 'Lambda function\nrowpack-serve-compile'),
  icon(930, 450, icons.s3, 'Amazon S3\nobjects/  builds/  locks/'),
  // 1: browser to CloudFront
  arrow([[112, 300], [268, 300]], 'GET /', { lx: 190, ly: 290 }),
  // 2: the page comes from the Web Function, requests signed by CloudFront
  arrow([[300, 268], [300, 200], [538, 200]], '/  (SigV4, signed by CloudFront)', { lx: 420, ly: 190 }),
  // 3: compile fan-out
  arrow([[602, 190], [898, 190]], 'source of modules S3 lacks', { lx: 750, ly: 180 }),
  arrow([[898, 212], [602, 212]], 'object files (SQLite)', { lx: 750, ly: 232 }),
  // 4: the Web Function reads and writes S3
  `<path d='M648,284 L898,428' fill='none' stroke='#545B64' stroke-width='1.6' marker-start='url(#a)' marker-end='url(#a)'/>`,
  text(790, 318, 'read cached objects,', { size: 11.5, anchor: 'start' }),
  text(790, 333, 'write new ones,', { size: 11.5, anchor: 'start' }),
  text(790, 348, 'upload the bundle', { size: 11.5, anchor: 'start' }),
  // 5: bundles from S3, cached at the edge
  arrow([[332, 312], [400, 312], [400, 470], [898, 470]], '/builds/*  bundles, cached at the edge', { lx: 650, ly: 460 }),
  step(190, 318, 1),
  step(316, 176, 2),
  step(750, 156, 3),
  step(770, 300, 4),
  step(650, 492, 5),
  ...legend.map((l, i) => step(40 + i * 212, 610, i + 1) + text(56 + i * 212, 614, l, { size: 12, anchor: 'start' })),
].join('\n'));

// ---- distributed benchmark ---------------------------------------------------------
const rows = [
  [150, 'rowpack-compile', 'Lambda function (Event Function)', 'one request per environment', 'Invoke API'],
  [300, 'rowpack-web-1thread', 'Lambda Web Function', 'many requests per environment, 1 thread', 'HTTPS, SigV4 (IamAuth)'],
  [450, 'rowpack-web-pool', 'Lambda Web Function', 'many requests per environment, a thread per vCPU', 'HTTPS, SigV4 (IamAuth)'],
];
const dist = svg(1000, 560, [
  icon(90, 300, icons.laptop, 'rowpack build\n(graph walk + SQLite)'),
  text(90, 392, 'ships module sources,\ngets rows or\nobject files back', { size: 11.5 }),
  group(200, 40, 780, 500, icons.cloud, 'AWS Cloud', '#232F3E'),
  group(290, 90, 670, 430, icons.region, 'eu-west-1', '#00A4A6'),
  ...rows.flatMap(([y, name, kind, note, via]) => [
    icon(520, y, icons.lambda, ''),
    text(565, y - 6, kind, { size: 12.5, anchor: 'start', weight: 600 }),
    text(565, y + 12, name, { size: 12.5, anchor: 'start' }),
    text(565, y + 30, note, { size: 11.5, anchor: 'start', fill: '#545B64' }),
    arrow([[122, 300], [240, 300], [240, y], [488, y]], via, { lx: 400, ly: y - 8 }),
  ]),
].join('\n'));

const out = path.join(import.meta.dirname);
fs.writeFileSync(path.join(out, 'serve-architecture.svg'), serve);
fs.writeFileSync(path.join(out, 'distributed-architecture.svg'), dist);

if (process.argv.includes('--png')) {
  const { launch } = await import('../../bench/browser.js');
  const browser = await launch();
  for (const [name, w, h] of [['serve-architecture', 1100, 650], ['distributed-architecture', 1000, 560]]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })).newPage();
    await page.goto(`file://${path.join(out, `${name}.svg`)}`);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
  await browser.close();
}
console.log('diagrams written to docs/diagrams/');
