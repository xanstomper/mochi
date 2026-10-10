
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1400,height:900}});
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const secs = await p.evaluate(() => [...document.querySelectorAll('section')].map(s => s.id || s.className.slice(0,20)));
  console.log('sections:', JSON.stringify(secs));
  const rb = await p.evaluate(() => !!document.querySelector('#repo .rb'));
  const treeItems = await p.evaluate(() => document.querySelectorAll('#repo .src-file, #repo .src-dir').length);
  console.log('repo browser mounted:', rb, '| tree items:', treeItems);
  await p.locator('#repo').scrollIntoViewIfNeeded();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/local_home_repo.png' });
  await b.close();
})();
