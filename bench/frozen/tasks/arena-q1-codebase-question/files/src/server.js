const {hash}=require("./auth.js");
function login(pw){ return hash(pw)===1337; }
module.exports={login};
