const fs=require('fs');const s=fs.readFileSync(require('path').join(__dirname,'..','bach','index.html'),'utf8');
const i=s.indexOf('const R=[');let j=s.indexOf('\n];',i)+3;
const R=new Function(s.slice(i,j)+';return R;')();
const EXP={fear:['Rock Rose','Mimulus','Cherry Plum','Aspen','Red Chestnut'],unc:['Cerato','Scleranthus','Gentian','Gorse','Hornbeam','Wild Oat'],pres:['Clematis','Honeysuckle','Wild Rose','Olive','White Chestnut','Mustard','Chestnut Bud'],lone:['Water Violet','Impatiens','Heather'],over:['Agrimony','Centaury','Walnut','Holly'],desp:['Larch','Pine','Elm','Sweet Chestnut','Star of Bethlehem','Willow','Oak','Crab Apple'],care:['Chicory','Vervain','Vine','Beech','Rock Water']};
const reg=R.filter(r=>r.en!=='Rescue Remedy');
console.log('total',R.length,'regular',reg.length,'rescue',R.some(r=>r.en==='Rescue Remedy'));
console.log('incomplete',R.filter(r=>!(r.he&&r.neg&&r.pos&&r.desc&&r.kw&&r.kw.length)).map(r=>r.en));
for(const g in EXP){const got=reg.filter(r=>r.g===g).map(r=>r.en).sort(),exp=EXP[g].slice().sort();console.log(JSON.stringify(got)===JSON.stringify(exp)?'OK  ':'DIFF',g,JSON.stringify(got)===JSON.stringify(exp)?'':JSON.stringify({got,exp}));}
console.log(R.map(r=>r.he+' ('+r.en+')').join(' | '));
