const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const title = document.querySelector('.hero-title');
    if (!title) return 'no title';
    const chars = title.querySelectorAll('.split-char');
    const firstChar = chars[0];
    const cs = firstChar ? getComputedStyle(firstChar) : null;
    const titleCS = getComputedStyle(title);
    return {
      numChars: chars.length,
      firstCharTransform: cs?.transform,
      firstCharPlayState: cs?.animationPlayState,
      firstCharDelay: cs?.animationDelay,
      titleBg: titleCS.backgroundImage,
      titleClip: titleCS.webkitTextFillColor,
      titleColor: titleCS.color,
      titleFont: titleCS.fontFamily,
      titleFontSize: titleCS.fontSize,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
