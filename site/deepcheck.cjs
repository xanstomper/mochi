const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const title = document.querySelector('.hero-title');
    if (!title) return 'no title';
    const firstWord = title.querySelector('.split-word');
    const firstChar = title.querySelector('.split-char');
    const wordCS = firstWord ? getComputedStyle(firstWord) : null;
    const charCS = firstChar ? getComputedStyle(firstChar) : null;
    const titleCS = getComputedStyle(title);
    // Check if title has display:none or visibility:hidden from parent
    let el = title;
    let chain = [];
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      chain.push({
        tag: el.tagName + '.' + (el.className||'').slice(0,30),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        height: el.offsetHeight, overflow: cs.overflow,
      });
      el = el.parentElement;
    }
    return {
      wordDisplay: wordCS?.display, wordOverflow: wordCS?.overflow,
      charDisplay: charCS?.display, charOpacity: charCS?.opacity,
      titleHeight: title.offsetHeight, titleRect: title.getBoundingClientRect(),
      chain,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
