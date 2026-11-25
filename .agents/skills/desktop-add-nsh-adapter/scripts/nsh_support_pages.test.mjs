import assert from 'node:assert/strict';
import test from 'node:test';
import { renderNshAdapterFiles } from './nsh_adapter_files.mjs';
import { renderNshSponsor } from './nsh_support_pages.mjs';

const profile = () => ({
  system_tray: 'disabled', system_notification: 'disabled', autostart: 'disabled',
  about_page: 'disabled', sponsor_page: 'disabled', single_instance: 'disabled',
  deep_link: 'disabled', global_shortcut: 'disabled', sidebar_mode: 'detailed',
});
const options = selected => ({
  projectId: 'sample_tool', nameZh: '示例工具', nameEn: 'Sample Tool', owner: 'Fixture Owner',
  targetPlatforms: ['macos'], nshTargets: ['desktop'],
  profile: Object.assign(profile(), Object.fromEntries(selected.map(key => [key, 'enabled']))),
});

test('disabled support pages and autostart leave no desktop imports, assets, or template tokens', () => {
  const files = renderNshAdapterFiles(options([]));
  const member = 'sample_tool_nsh/';
  assert.equal(files.has(member + 'about.tsx'), false);
  assert.equal(files.has(member + 'sponsor.tsx'), false);
  assert.equal([...files.keys()].some(name => name.startsWith(member + 'assets/sponsor/')), false);
  assert.doesNotMatch(files.get(member + 'translations.ts'), /start_at_login|autostart_error|deep_link_received/u);
  for (const name of ['App.tsx', 'desktop.tsx']) {
    const source = files.get(member + name);
    assert.doesNotMatch(source, /__AUTOSTART_IMPORT__|__[A-Z][A-Z_]+__|BaseSwitch|autostart\.get|autostart\.set|\.\/about|\.\/sponsor/u);
  }
});

test('enabled support pages use structured copy, available content width', () => {
  const files = renderNshAdapterFiles(options(['about_page', 'sponsor_page']));
  const member = 'sample_tool_nsh/';
  const app = files.get(member + 'App.tsx');
  const about = files.get(member + 'about.tsx');
  const sponsor = files.get(member + 'sponsor.tsx');
  const desktop = files.get(member + 'desktop.tsx');
  assert.match(app, /\{page\(\) === "settings" &&/u);
  assert.match(app, /SponsorPage language=\{language\(\)\} availableWidth=\{Math\.max\(0, windowSize\(\)\.width - \(narrow\(\) \? 0 : Number\(sidebarWidth\(\)\)\)/u);
  const content = JSON.parse(files.get(member + 'locales/en.json'));
  assert.equal(content['about.owner'], 'Fixture Owner');
  for (const key of ['contact', 'contactDetail', 'releaseNotes']) assert.equal(typeof content['about.' + key], 'string');
  assert.equal(Object.keys(content).filter(key => key.startsWith('about.disclaimerItems.')).length, 3);
  assert.match(about, /tr\(props\.language, "about\.releaseNotes"\)/u);
  assert.doesNotMatch(about, /CONTENT_ZH|CONTENT_EN/u);
  assert.doesNotMatch(sponsor, /const copy|\[props\.language\]/u);
  assert.match(about, /labels\(\)\.disclaimerItems\.map/u);
  assert.match(sponsor, /props\.availableWidth|tokens\.sponsorCardMinWidth \* 3|backgroundImage|paymentImageSize/u);
  assert.doesNotMatch(desktop, /__AUTOSTART_IMPORT__|__[A-Z][A-Z_]+__/u);
});

test('sponsor generator uses supplied media, currency, and official translation keys', () => {
  const brand = { sponsor: {
    background: 'sponsor/banner.png',
    tiers: [{ image: 'sponsor/tier.png', nameKey: 'sponsor.tier_name', imageAltKey: 'sponsor.tier_alt', currencyCode: 'USD', price: 7, benefits: [{ mainKey: 'sponsor.benefit' }] }],
    payments: [{ image: 'sponsor/payment.png', altKey: 'sponsor.payment_alt' }],
  } };
  const source = renderNshSponsor(brand);
  for (const filename of ['banner.png', 'tier.png', 'payment.png']) assert.match(source, new RegExp(filename.replace('.', '\\.'), 'u'));
  assert.match(source, /USD 7/u);
  assert.match(source, /tr\(props\.language, "sponsor\.payment_instructions"\)/u);
  assert.match(source, /"sponsor\.tier_name"|tokens\.sponsorMaxWidth/u);
  assert.match(source, /const columns = \(\) => width\(\) >= tokens\.sponsorCardMinWidth \* 3/u);
});
