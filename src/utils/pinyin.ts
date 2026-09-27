/**
 * v0.9.77 P2-16：字段拼音首字母搜索（零依赖内置常用汉字首字母表）。
 *
 * 定位：灵活查询字段面板的搜索框支持「jgmc → 机构名称」这类拼音首字母命中，
 * 解决中文列名输入法切换成本高的问题。表按拼音首字母分组收敛（约 800 常用字，
 * 覆盖业务字段命名高频字），未收录的生僻字跳过即可（名称/描述直接包含匹配仍生效）。
 *
 * 多音字取字段命名场景最常见读音（行→h、长→c、重→z、数→s、调→d），
 * 命中失败仅少一个搜索别名，不影响正确性。
 */

/** 拼音首字母分组表（键为 a~z，值为该首字母下的常用汉字） */
const PINYIN_GROUPS: Record<string, string> = {
  a: '阿啊哀唉挨矮爱安按案暗昂奥',
  b: '八巴拔把爸罢白百摆败拜班般搬板版办半帮包宝饱保报暴杯悲北备背贝被本比笔币必毕闭边编变便遍标表别宾冰兵并病播波伯博补不布步部',
  c: '才材财采彩菜参餐残灿仓苍操草册侧测层查茶差拆产长常厂场畅唱超朝车彻沉陈趁称成城承充冲虫抽出初除厨处川穿传船串窗床创吹春词此刺次匆从村存错',
  d: '搭达答打大代带待单担但淡当党刀导到倒道得的灯登低敌底地弟第点电店调掉丁顶订定东冬懂动都豆独读度短段断对队多',
  e: '额恶饿儿而耳二',
  f: '发法番翻凡反饭范方防房访放飞非费分份丰风封峰否夫服福府父付负妇复副',
  g: '该改概干甘赶敢感刚钢高搞告哥格个各给根跟更工公功共供狗构购够姑古谷股骨鼓固故顾瓜挂关观官管惯光广归规贵滚国果过',
  h: '哈孩海含寒喊汉行好号合何和河核红后厚候呼湖户花华划化话怀欢环换黄回会汇婚活火或货获',
  j: '击机鸡积基绩激及吉级极即急集几己挤计记纪技季济既继加家甲价架坚间检简见件建健江将讲交角脚教接街节结解姐介界今金仅进近京经精井景净竟静九久酒旧救居局举巨具剧据卷决绝军',
  k: '卡开看康考科可克刻客课肯空口扣哭苦库块快宽况矿困扩',
  l: '拉来蓝览烂郎劳老乐类冷离李里理力历立利例连联脸练良凉两量列林临灵领另流留六龙楼漏路录陆乱论罗落',
  m: '妈麻马码买麦卖满慢忙毛贸么没每美门闷们梦米密免面苗秒民名明命摸模磨末莫某母木目',
  n: '拿哪内那纳乃奶耐男南难脑闹呢能你年念娘鸟您宁牛农弄女暖',
  o: '欧偶',
  p: '爬怕拍排牌派盘判旁胖跑泡陪配喷朋批皮片票品平评瓶破铺普',
  q: '七期齐其奇骑棋旗企启起气器千迁前钱浅强抢桥巧切亲轻清晴请庆穷秋求球区曲取去全权劝缺群',
  r: '然让热人认任日容肉如入软',
  s: '三伞散色森杀沙山删闪善商上少绍设社身深神审升生声胜师失十石时识实食史使始世市式事势视试售收手守首受书叔输熟属术束树数刷双水税顺说思斯四寺松送苏俗素速算虽随岁孙所',
  t: '他它她台太态谈坦汤唐堂糖躺涛讨套特提题体天田条调跳贴铁听停通同童统头投透图土团推退托',
  w: '挖外完玩晚万王网往忘望危威微为围维伟委卫未位味温文闻问乌无五午武务物误',
  x: '西吸希析息习席洗喜系细下夏先显险现线相香详想向项象消销小效些协写谢心新信星行形醒兴姓幸性兄修需许序宣选学雪血询寻迅',
  y: '压牙亚烟严言研盐演眼验央扬羊阳样要药也业叶页夜一衣医依仪已以义亿艺议异易意因阴音银引印应英营影映硬永用优由油游友有右于余鱼与雨语育预元员原园源远院愿约月阅云运',
  z: '杂灾再在早造则责增张章涨招找照折者这真整正政之支知直值职止只纸志制治质中忠终钟种重周州朱主助住注专转装状准资子字自总走足族组最左作坐',
};

/** 汉字 → 首字母映射（模块级懒构建，仅首次搜索时展开分组表） */
let hanziMap: Map<string, string> | null = null;

function getHanziMap(): Map<string, string> {
  if (hanziMap) return hanziMap;
  const m = new Map<string, string>();
  for (const [letter, chars] of Object.entries(PINYIN_GROUPS)) {
    for (const ch of chars) {
      // 多音字保留首个分组（分组表已按字段命名高频读音收录）
      if (!m.has(ch)) m.set(ch, letter);
    }
  }
  hanziMap = m;
  return m;
}

/**
 * 文本 → 拼音首字母串：中文取首字母、字母数字保留（转小写）、其余字符跳过。
 * 例：「机构名称 JGMC」→ "jgmcjgmc"、「销售额(万元)」→ "xsewy"。
 */
export function pinyinInitials(text: string): string {
  const map = getHanziMap();
  let out = '';
  for (const ch of String(text || '')) {
    if (ch.charCodeAt(0) < 128) {
      if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
      continue;
    }
    const letter = map.get(ch);
    if (letter) out += letter;
  }
  return out;
}

/**
 * 字段搜索匹配（v0.9.77 P2-16）：名称/描述直接包含（既有行为）或拼音首字母包含。
 * 关键字含中文走包含匹配；纯字母数字关键字额外尝试首字母匹配（如 jgmc 命中「机构名称」）。
 */
export function matchFieldSearch(keyword: string, name: string, description = ''): boolean {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return true;
  if (`${name} ${description}`.toLowerCase().includes(kw)) return true;
  if (/^[a-z0-9_]+$/.test(kw)) {
    const initials = pinyinInitials(`${name}${description ? ' ' + description : ''}`);
    if (initials.includes(kw)) return true;
  }
  return false;
}
