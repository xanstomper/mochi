const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  const checks = await p.evaluate(() => {
    const q = s => document.querySelectorAll(s).length;
    const tw = document.querySelector('.typewriter');
    const twText = tw ? tw.textContent.trim() : '';
    const gooey = document.querySelectorAll('.gooey-wrap').length;
    const termGooey = getComputedStyle(document.querySelector('.term2')).animationName;
    const marquee = document.querySelectorAll('.marquee2-item').length;
    const mag = document.querySelectorAll('.magnetic').length;
    const scroll = !!document.querySelector('.scroll-progress');
    const tilt = !!document.querySelector('.tilt');
    // check gooey border animates (conic gradient from angle changes)
    const gw = document.querySelector('.gooey-wrap');
    const gAnim = gw ? getComputedStyle(gw).animationName : 'none';
    // typewriter actually typing (text grows over time)
    return { tw: !!tw, twText: twText.slice(0,40), gooey, gAnim, marquee, mag, scroll, tilt, termGooey };
  });
  console.log(JSON.stringify(checks, null, 1));
  // typewriter should grow over 2s
  await p.waitForTimeout(2000);
  const tw2 = await p.evaluate(() => {
    const tw = document.querySelector('.typewriter');
    return tw ? tw.textContent.trim().length : 0;
  });
  console.log('typewriter len after 2s:', tw2);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
