/**
 * 前端密码强度与用户名格式校验（v0.9.68）。
 * 规则与 server/auth/passwords.ts 的 validatePasswordStrength、server/routes/admin.ts 的 USERNAME_PATTERN
 * 保持一致（tsconfig.server.json 编译范围仅含 server/**，前后端无法共享模块，两处须同步修改）：
 * 密码 8-64 位且同时包含字母和数字；排除常见弱口令；不得包含用户名。
 * 用途：新建用户 / 强制改密表单的即时反馈——避免「确认按钮灰掉却无原因提示」或「按钮可点却被服务端拒绝」。
 */
export interface PasswordCheckResult {
  ok: boolean;
  error?: string;
}

/** 与服务端 USERNAME_PATTERN 一致：3-20 位字母、数字或下划线（不含中文等非 ASCII 字符） */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

/** 用户名格式提示（与服务端 400 错误文案一致） */
export const USERNAME_HINT = '用户名需为 3-20 位字母、数字或下划线（不支持中文）';

/** 密码规则提示（与服务端强度校验一致，用于 label 副说明） */
export const PASSWORD_HINT = '8-64 位，同时包含字母和数字';

// 与服务端 WEAK_PASSWORDS 同步（小写比对）
const WEAK_PASSWORDS = new Set([
  'admin123', 'admin888', 'password', 'password1', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', 'qwerty123', 'abc12345',
  '11111111', '88888888', '66668888', 'letmein123', 'welcome123',
]);

export function checkPasswordStrength(pwd: string, username?: string): PasswordCheckResult {
  if (pwd.length < 8 || pwd.length > 64) {
    return { ok: false, error: '密码长度需为 8-64 位' };
  }
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) {
    return { ok: false, error: '密码需同时包含字母和数字' };
  }
  if (WEAK_PASSWORDS.has(pwd.toLowerCase())) {
    return { ok: false, error: '密码为常见弱口令，请更换为更复杂的组合' };
  }
  if (username && pwd.toLowerCase().includes(username.toLowerCase())) {
    return { ok: false, error: '密码不能包含用户名' };
  }
  return { ok: true };
}
