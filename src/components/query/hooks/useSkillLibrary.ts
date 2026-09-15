import React, { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../../../api/client';

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
}

/**
 * 技能库状态与加载（P0 上帝组件拆分：自 QueryChat 提取，行为保持一致）。
 * P2-A Skills：可复用分析技能（点击填充提问模板，占位符由用户替换后提交）；
 * 含技能「+」弹出菜单（点击面板外部自动关闭）与技能库管理弹窗开关。
 */
export function useSkillLibrary() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  // 技能「+」弹出菜单（参照 Qoder IDE「+」交互：点击输入框旁 + 号向上弹出技能选择面板）
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const skillMenuRef = useRef<HTMLDivElement>(null);

  const loadSkills = React.useCallback(() => {
    apiFetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data?.skills)) setSkills(data.skills);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // 技能「+」菜单：点击面板外部自动关闭
  useEffect(() => {
    if (!skillMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) setSkillMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [skillMenuOpen]);

  return {
    skills,
    skillLibraryOpen,
    setSkillLibraryOpen,
    skillMenuOpen,
    setSkillMenuOpen,
    skillMenuRef,
    loadSkills,
  };
}
