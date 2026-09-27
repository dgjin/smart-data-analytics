import { describe, expect, it } from 'vitest';
import { matchFieldSearch, pinyinInitials } from './pinyin';

describe('pinyinInitials / 字段拼音首字母（v0.9.77 P2-16）', () => {
  it('中文取首字母、字母数字保留小写、符号跳过', () => {
    expect(pinyinInitials('机构名称')).toBe('jgmc');
    expect(pinyinInitials('销售额(万元)')).toBe('xsewy');
    expect(pinyinInitials('JGMC 机构代码')).toBe('jgmcjgdm');
    expect(pinyinInitials('')).toBe('');
  });

  it('未收录生僻字跳过（不抛错）', () => {
    expect(pinyinInitials('龘靐')).toBe('');
  });

  it('多音字按字段命名高频读音（行→h、长→c、重→z）', () => {
    expect(pinyinInitials('银行')).toBe('yh');
    expect(pinyinInitials('长度')).toBe('cd');
    expect(pinyinInitials('重量')).toBe('zl');
  });
});

describe('matchFieldSearch / 字段搜索匹配（v0.9.77 P2-16）', () => {
  it('空关键字命中全部', () => {
    expect(matchFieldSearch('', 'JGMC')).toBe(true);
    expect(matchFieldSearch('   ', 'JGMC')).toBe(true);
  });

  it('名称/描述直接包含（既有行为）', () => {
    expect(matchFieldSearch('jgmc', 'JGMC')).toBe(true);
    expect(matchFieldSearch('机构', 'JGMC', '机构名称')).toBe(true);
    expect(matchFieldSearch('不存在', 'JGMC', '机构名称')).toBe(false);
  });

  it('拼音首字母命中（jgmc → 机构名称；mc → 名称）', () => {
    expect(matchFieldSearch('jgmc', '机构名称')).toBe(true);
    expect(matchFieldSearch('mc', '机构名称')).toBe(true);
    expect(matchFieldSearch('xse', '销售额(万元)')).toBe(true);
    expect(matchFieldSearch('zz', '机构名称')).toBe(false);
  });

  it('中文关键字不做拼音匹配（避免误命中）', () => {
    expect(matchFieldSearch('机', '机构名称')).toBe(true);
    expect(matchFieldSearch('构机', '机构名称')).toBe(false);
  });
});
