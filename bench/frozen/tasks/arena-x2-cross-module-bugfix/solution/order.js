const {itemCount}=require("./inventory.js");
function total(items){ let t=0; for(const i of items){ t += i.price * i.qty; } return t; }
module.exports={total};
