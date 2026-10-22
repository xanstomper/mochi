const {fmtPrice}=require("./util.js");
function renderCart(items){ return items.map(i=>fmtPrice(i.cents)).join(", "); }
module.exports={renderCart};
