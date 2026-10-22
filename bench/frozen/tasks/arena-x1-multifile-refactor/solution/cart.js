const {formatPrice}=require("./util.js");
function renderCart(items){ return items.map(i=>formatPrice(i.cents)).join(", "); }
module.exports={renderCart};
