// Writes the static logo files in app/static/brand/ from app/static/brand.js.
// Run: node scripts/make_brand_files.js
// The PNG app icon needs a browser to draw it: see README, "Logo files".
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'app', 'static', 'brand.js'));
const B = globalThis.PinbinBrand;
const out = path.join(__dirname, '..', 'app', 'static', 'brand');
fs.mkdirSync(out, { recursive: true });
const write = (name, svg) => fs.writeFileSync(path.join(out, name), svg + '\n');

write('favicon.svg', B.faviconSvg(B.DEFAULT_LOGO_COLOR));
write('app-icon.svg', B.appIconSvg(B.DEFAULT_LOGO_COLOR, 180));
// One-colour masters: they take the colour of the text around them.
write('pinbin-mark.svg', B.markSvg(32));
write('pinbin-mark-small.svg', B.markSvg(16, { small: true }));
write('pinbin-wordmark.svg', B.wordSvg(24));
console.log('wrote', fs.readdirSync(out).join(', '));
