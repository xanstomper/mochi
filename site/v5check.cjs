const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,150)));
  p.on('console', m => { if (m.type() === 'error') errs.push('c: ' + m.text().slice(0,80)); });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const hero = await p.evaluate(() => {
    const h = document.querySelector('.hero');
    const title = document.querySelector('.hero-title');
    const ticker = document.querySelector('.stats-ticker');
    const cap = document.querySelector('.cream-section');
    const mascot = document.querySelector('.mascot-bubble');
    return {
      heroExists: !!h, heroH: h?.offsetHeight, viewportH: window.innerHeight,
      titleVisible: title ? getComputedStyle(title).opacity : 'none',
      titleText: title?.textContent?.slice(0,30),
      tickerVisible: !!ticker, tickerH: ticker?.offsetHeight,
      capExists: !!cap, capBg: cap ? getComputedStyle(cap).backgroundColor : 'none',
      mascotExists: !!mascot, mascotSize: mascot ? mascot.offsetWidth : 0,
    };
  });
  console.log(JSON.stringify(hero, null, 1));
  console.log('errors:', errs.length ? errs : 'NONE');
  await p.screenshot({ path: '/tmp/v5_hero.png', clip:{x:0,y:0,width:1920,height:1080} });
  // scroll to capabilities
  await p.evaluate(() => window.scrollTo(0, 1080));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_caps.png', clip:{x:0,y:0,width:1920,height:1080} });
  // terminal
  await p.evaluate(() => window.scrollTo(0, 3000));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_term.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('shots done');
  await b.close();
})();
