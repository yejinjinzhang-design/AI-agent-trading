/**
 * 从口令派生出 cookie token。
 * 简单的 deterministic 哈希：只要 APP_PASSWORD 不泄露，cookie 值就无法反推口令。
 * 不是加密强度方案，仅用于单用户私有部署。
 */
export function expectedToken(password: string): string {
  let h = 0;
  const salt = "coral-salt-v1";
  const s = password + salt;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return `t_${h.toString(16)}`;
}

export const AUTH_COOKIE = "coral_auth";
