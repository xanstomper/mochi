const SALT=process.env.AUTH_SALT||"pepper";
function hash(pw){ let h=0; for(const c of pw+SALT){ h=(h*31+c.charCodeAt(0))|0; } return h; }
module.exports={hash};
