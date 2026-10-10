const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const hero = document.querySelector('.hero');
    const copy = document.querySelector('.hero-copy');
    const mascot = document.querySelector('.hero-mascot');
    const title = document.querySelector('.hero-title');
    const bg = document.querySelector('.sky-bg');
    const deco = document.querySelector('.deco-layer');
    const heroR = hero?.getBoundingClientRect();
    const copyR = copy?.getBoundingClientRect();
    const titleR = title?.getBoundingClientRect();
    const bgR = bg?.getBoundingClientRect();
    const bgZ = bg ? getComputedStyle(bg).zIndex : 'none';
    const heroZ = hero ? getComputedStyle(hero).zIndex : 'none';
    const copyDisplay = copy ? getComputedStyle(copy).display : 'none';
    const titleOpacity = title ? getComputedStyle(title).opacity : 'none';
    const titleColor = title ? getComputedStyle(title).color : 'none';
    const titleClip = title ? getComputedStyle(title).webkitTextFillColor : 'none';
    return { heroR, copyR, titleR, bgZ, heroZ, copyDisplay, titleOpacity, titleColor, titleClip };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
