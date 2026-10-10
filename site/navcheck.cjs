const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const pg of ['index.html','docs.html','benchmarks.html','changelog.html','source.html']) {
    await p.goto('http://127.0.0.1:8937/mochi/'+pg, {waitUntil:'networkidle'});
    const cur = await p.$$eval('header nav a[aria-current]', as => as.map(a => a.textContent));
    console.log(pg, '->', JSON.stringify(cur));
  }
  await b.close();
})();
