const normalize=value=>String(value||"").normalize("NFKC").toLowerCase().replace(/足球俱乐部|俱乐部|fc/g,"").replace(/[\s·.・()（）\-_/]/g,"");

// 只收录已经由官方赛程日期、开赛时间和主客顺序交叉确认过的中文简称。
// 别名仅用于生成稳定身份键，不能单独作为赛事匹配依据。
const aliasGroups={
 "alshabab":["利雅青年","利雅得青年人"],
 "sportingcp":["里斯本","葡萄牙体育"],
 "galatasaray":["加拉塔萨","加拉塔萨雷"],
 "psg":["巴黎圣曼","巴黎圣日耳曼"],
 "slovanbratislava":["布拉迪斯","布拉迪斯拉发"],
 "qpr":["女王巡游","女王公园"],
 "moreirense":["摩雷伦斯","莫雷拉人","莫雷拉"],
 "palmeiras":["帕梅拉斯","帕尔梅拉斯"],
 "lduquito":["基多体大","基多大学","基多大学体育"],
 "estudiantes":["拉普大学","拉普拉塔大学生"],
 "chicagofire":["芝加哥","芝加哥火焰"],
 "intermiami":["迈国际","迈阿密国际"],
 "rbLeipzig":["莱红牛","RB莱比锡","莱比锡红牛"],
 "slaviaPrague":["斯拉维亚","布拉格斯拉维亚"],
 "estrelaAmadora":["阿马多拉","阿马多拉之星"],
 "independienteDelValle":["德尔瓦耶","山谷独立"],
 "kyotoSanga":["京都","京都不死鸟"],
 "alfaisalyHarmah":["哈马费萨","费萨里"],
 "azAlkmaar":["阿尔克马","阿尔克马尔"],
 "mvvMaastricht":["马斯特里","马斯特里赫特"],
 "almereCity":["阿尔梅勒","阿尔梅勒城"],
 "wrexham":["雷克斯","雷克瑟姆"],
 "valencia":["巴伦西亚","瓦伦西亚"],
 "athleticoParanaense":["巴竞技","巴拉纳竞技"],
 "racingSantander":["桑坦德","桑坦德竞技"],
 "frosinone":["弗洛西诺","弗罗西诺内"],
 "brentford":["布伦特","布伦特福德"],
 "astonVilla":["维拉","阿斯顿维拉"],
 "nottinghamForest":["诺丁汉","诺丁汉森林"],
 "ipswichTown":["伊普斯","伊普斯维奇"],
 "strasbourg":["斯特拉斯","斯特拉斯堡"],
 "alTaawoun":["布赖合作","布赖代合作"],
 "alHilal":["利雅新月","利雅得新月"],
 "werderBremen":["不来梅","云达不莱梅"],
 "casaPia":["卡萨皮亚","卡萨比亚"],
 "fortunaSittard":["福图纳","福图纳锡塔德"],
 "consadoleSapporo":["札幌冈萨","札幌冈萨多"],
 "kuopioPalloseura":["库奥皮奥","库普斯"],
 "elversberg":["埃沃斯堡","埃尔沃斯贝格"],
 "getafe":["赫塔费","赫塔菲"],
 "deportivoCoruna":["拉科","拉科鲁尼亚"],
 "gilVicente":["吉维森特","吉尔维森特"],
 "spartaRotterdam":["鹿斯巴达","鹿特丹斯巴达"],
 "juventus":["尤文","尤文图斯"],
 "newEnglandRevolution":["新英格兰","新英格兰革命"],
 "interTurku":["国际图尔","图尔库国际"],
 "vpsVaasa":["瓦萨","VPS瓦萨"],
 "djurgarden":["佐加顿斯","尤尔加登"],
 "gais":["盖斯","哥德堡盖斯"],
 "sandefjord":["桑纳菲","桑德菲杰"],
 "pakhtakor":["棉农","塔什干棉农"],
 "interMilan":["国际米兰","国米"],
 "redStarSaintOuen":["圣旺红星"],
 "newcastleUnited":["纽卡斯尔","纽卡斯尔联"],
 "villarreal":["比利亚雷","比利亚雷亚尔"],
 "estoril":["埃斯托里","埃斯托里尔"],
 "chinaWomen":["中国女","中国女足"],
 "hongKongWomen":["中国港女","中国香港女足"],
 "qatarU23":["卡塔尔亚","卡塔尔U23"],
 "saudiArabiaU23":["沙特亚","沙特阿拉伯U23"],
 "southKoreaU23":["韩国亚","韩国U23"],
 "johorDarulTazim":["柔佛","柔佛新山"],
 "buriramUnited":["布里兰","武里南联"],
 "pohangSteelers":["浦项制铁","浦项铁人"],
 "alAin":["阿布艾因","艾因"],
 "alNassr":["利雅胜利","利雅得胜利"],
 "middlesbrough":["米堡","米德尔斯堡"],
 "fluminense":["弗鲁米嫩","弗鲁米嫩塞"],
 "sturmGraz":["格风暴","格拉茨风暴"],
 "anderlecht":["安德莱","安德莱赫特"],
 "uzbekistanWomen":["乌兹别女","乌兹别克斯坦女足"],
 "ofiCrete":["克里特","OFI克里特"],
 "lechPoznan":["波兹南","波兹南莱赫"],
 "besiktas":["贝西克塔","贝西克塔斯"],
 "lillestrom":["利勒斯特","利勒斯特罗姆"],
 "torreense":["托林斯","托伦斯"],
 "gnistan":["赫尔火花","格尼斯坦"],
 "wolfsburg":["沃夫斯堡","沃尔夫斯堡"],
 "darmstadt":["达姆施塔","达姆施塔特"],
 "kfumOslo":["奥斯KFUM","KFUM奥斯陆"],
 "denBosch":["登博思","邓伯什"],
 "helmondSport":["海尔蒙特","赫尔蒙德"],
 "bristolCity":["布城","布里斯托尔城"],
 "rbOmiyaArdija":["大宫松鼠","RB大宫松鼠"],
 "ulsanHd":["蔚山现代","蔚山HD"],
 "vasterasSk":["韦斯特罗","瓦斯特拉斯"],
 "kristiansundBk":["克里斯蒂","克里斯蒂安松"],
 "mirassol":["米拉索尔","米拉索"],
 "iranU23":["伊朗亚","伊朗U23"],
 "chinaU23":["中国亚","中国U23"],
 "machidaZelvia":["町田泽维","町田泽维亚"],
 "visselKobe":["神户胜利","神户胜利船"],
 "kyrgyzstanU23":["吉尔吉亚","吉尔吉斯斯坦U23"],
 "japanU23":["日本亚","日本U23"],
 "northKoreaU23":["朝鲜亚","朝鲜U23"],
 "heraclesAlmelo":["赫拉克勒","赫拉克勒斯"],
 "vitesseArnhem":["维迪斯","维特斯"],
 "newYorkRedBulls":["纽约红牛","纽约红牛队"],
 "stLouisCity":["圣路易城","圣路易斯城"],
 "philadelphiaUnion":["费城","费城联合"],
 "orlandoCity":["奥兰多","奥兰多城"],
 "laGalaxy":["洛城银河","洛杉矶银河"],
 "coloradoRapids":["科罗拉多","科罗拉多急流"],
 "wolverhampton":["伍尔弗","狼队"],
 "westBromwichAlbion":["西布罗姆","西布罗姆维奇"],
 "miltonKeynesDons":["米尔顿","米尔顿凯恩斯"],
 "grimsbyTown":["格里姆","格林斯比"],
 "wiganAthletic":["维冈","维冈竞技"],
 "unitedArabEmiratesU23":["阿联酋亚","阿联酋U23"],
 "thailandU23":["泰国亚","泰国U23"],
 "seattleSounders":["西雅图","西雅图海湾人"],
 "realSaltLake":["盐湖城","皇家盐湖城"],
};

export const TEAM_ALIAS_VERSION="verified-zh-aliases-2026-09-26.1";
export const TEAM_ALIAS_INDEX=new Map(Object.entries(aliasGroups).flatMap(([identity,names])=>names.map(name=>[normalize(name),identity])));
export const teamIdentity=(value,league="")=>{
 const name=normalize(value);
 // “红星”并非唯一球队名，只在已核实的法乙赛程中对应圣旺红星。
 if(name===normalize("红星")&&normalize(league)===normalize("法乙"))return "redStarSaintOuen";
 return TEAM_ALIAS_INDEX.get(name)||name;
};

// 仅作为“同一彩票编号 + 同一开赛时间”后的二次校验：允许常见的中文截断，
// 不把模糊相似度单独用于寻找赛事，避免相近队名跨场误配。
export const teamNamesCompatible=(left,right,leftLeague="",rightLeague="")=>{
 const leftIdentity=teamIdentity(left,leftLeague),rightIdentity=teamIdentity(right,rightLeague);
 if(!leftIdentity||!rightIdentity)return false;
 if(leftIdentity===rightIdentity)return true;
 const leftName=normalize(left),rightName=normalize(right),shorter=leftName.length<=rightName.length?leftName:rightName,longer=leftName.length<=rightName.length?rightName:leftName;
 // 该兼容判断只会在同一竞彩编号、同一比赛日期和相近开赛时间已经成立后使用。
 // 允许“西雅图 / 西雅图海湾人”“盐湖城 / 皇家盐湖城”这类中文简称，
 // 但要求至少三个连续汉字且全名最多只多三个字符，避免把相近队名误合并。
 return shorter.length>=3&&longer.includes(shorter)&&longer.length-shorter.length<=3;
};
